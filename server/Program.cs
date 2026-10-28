using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Channels;
using Microsoft.AspNetCore.RateLimiting;
using Mingle.Server;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 64 * 1024);
builder.Services.AddRateLimiter(options =>
{
    options.AddFixedWindowLimiter("account", limiter =>
    {
        limiter.PermitLimit = 12;
        limiter.Window = TimeSpan.FromMinutes(5);
        limiter.QueueLimit = 0;
        limiter.AutoReplenishment = true;
    });
    options.AddFixedWindowLimiter("profile-lookup", limiter =>
    {
        limiter.PermitLimit = 60;
        limiter.Window = TimeSpan.FromMinutes(5);
        limiter.QueueLimit = 0;
        limiter.AutoReplenishment = true;
    });
});
builder.Services.AddSingleton(sp =>
{
    var configuredPath = Environment.GetEnvironmentVariable("MINGLE_DATA_PATH");
    var directory = string.IsNullOrWhiteSpace(configuredPath)
        ? Path.Combine(builder.Environment.ContentRootPath, "App_Data")
        : configuredPath;
    return new PersistentChatStore(directory);
});
builder.Services.AddSingleton<RealtimeHub>();
builder.Services.AddSingleton(sp =>
{
    var configuredPath = Environment.GetEnvironmentVariable("MINGLE_DATA_PATH");
    var directory = string.IsNullOrWhiteSpace(configuredPath)
        ? Path.Combine(builder.Environment.ContentRootPath, "App_Data")
        : configuredPath;
    var subject = Environment.GetEnvironmentVariable("MINGLE_VAPID_SUBJECT") ?? "mailto:admin@example.com";
    return new WebPushSender(
        sp.GetRequiredService<PersistentChatStore>(),
        directory,
        subject,
        sp.GetRequiredService<ILogger<WebPushSender>>());
});

var app = builder.Build();
var storeOnStartup = app.Services.GetRequiredService<PersistentChatStore>();
await storeOnStartup.InitializeAsync();
var pushSender = app.Services.GetRequiredService<WebPushSender>();

app.Use(async (context, next) =>
{
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    context.Response.Headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
    context.Response.Headers["X-Frame-Options"] = "DENY";
    context.Response.Headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
    context.Response.Headers["Content-Security-Policy"] =
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";

    if (context.Request.Path.StartsWithSegments("/api")
        && !HttpMethods.IsGet(context.Request.Method)
        && !string.Equals(
            context.Request.Headers["X-Requested-With"],
            "Mingle",
            StringComparison.Ordinal))
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        await context.Response.WriteAsJsonAsync(
            new { error = "This request could not be verified. Reload the page and try again." },
            context.RequestAborted);
        return;
    }

    await next();
});
app.UseRateLimiter();
app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = context =>
    {
        context.Context.Response.Headers.CacheControl = context.File.Name is "index.html" or "app.js" or "sw.js"
            ? "no-cache"
            : "public,max-age=3600";
    }
});

app.MapGet("/api/health", () => Results.Json(new { status = "ok" }));

app.MapPost("/api/auth/register", async (
    RegisterRequest request,
    HttpContext context,
    PersistentChatStore store) =>
{
    var name = request.Name?.Trim();
    var phone = request.Phone?.Trim();
    var password = request.Password;

    if (string.IsNullOrWhiteSpace(name) || name.Length > 40)
    {
        return Results.Json(new { error = "Enter a name between 1 and 40 characters." }, statusCode: StatusCodes.Status400BadRequest);
    }
    if (phone is null || !Regex.IsMatch(phone, "^[0-9]{10}$", RegexOptions.CultureInvariant))
    {
        return Results.Json(new { error = "Enter exactly 10 digits for your mobile number." }, statusCode: StatusCodes.Status400BadRequest);
    }
    if (password is null || password.Length < 8 || Encoding.UTF8.GetByteCount(password) > 1024)
    {
        return Results.Json(new { error = "Choose a password with at least 8 characters." }, statusCode: StatusCodes.Status400BadRequest);
    }

    var (account, phoneAlreadyUsed) = await store.CreateAccountAsync(name, phone, password, context.RequestAborted);
    if (phoneAlreadyUsed)
    {
        return Results.Json(new { error = "This mobile number already has an account. Please log in instead." }, statusCode: StatusCodes.Status409Conflict);
    }
    if (account is null)
    {
        return Results.Json(new { error = "Could not create the account. Please try again." }, statusCode: StatusCodes.Status500InternalServerError);
    }

    WriteSessionCookie(context, store.CreateSession(account), app.Environment.IsDevelopment());
    return Results.Json(
        new { profile = PersistentChatStore.ToPublicProfile(account) },
        statusCode: StatusCodes.Status201Created);
}).RequireRateLimiting("account");

app.MapPost("/api/auth/login", async (
    LoginRequest request,
    HttpContext context,
    PersistentChatStore store) =>
{
    var phone = request.Phone?.Trim();
    if (phone is null
        || !Regex.IsMatch(phone, "^[0-9]{10}$", RegexOptions.CultureInvariant)
        || string.IsNullOrEmpty(request.Password))
    {
        return Results.Json(new { error = "Enter your 10-digit mobile number and password." }, statusCode: StatusCodes.Status400BadRequest);
    }

    var account = await store.ValidateLoginAsync(phone, request.Password, context.RequestAborted);
    if (account is null)
    {
        return Results.Json(new { error = "The mobile number or password is incorrect." }, statusCode: StatusCodes.Status401Unauthorized);
    }

    WriteSessionCookie(context, store.CreateSession(account), app.Environment.IsDevelopment());
    return Results.Json(new { profile = PersistentChatStore.ToPublicProfile(account) });
}).RequireRateLimiting("account");

app.MapGet("/api/me", async (HttpContext context, PersistentChatStore store) =>
{
    var account = await GetCurrentAccountAsync(context, store);
    return account is null
        ? Results.Json(new { error = "Please log in to continue." }, statusCode: StatusCodes.Status401Unauthorized)
        : Results.Json(new { profile = PersistentChatStore.ToPublicProfile(account) });
});

app.MapPost("/api/auth/logout", (
    HttpContext context,
    PersistentChatStore store) =>
{
    store.RemoveSession(context.Request.Cookies["mingle_session"]);
    context.Response.Cookies.Delete("mingle_session", SessionCookieOptions(context, app.Environment.IsDevelopment()));
    return Results.NoContent();
});

app.MapGet("/api/users/{accountNumber}", async (
    string accountNumber,
    HttpContext context,
    PersistentChatStore store) =>
{
    var account = await GetCurrentAccountAsync(context, store);
    if (account is null)
    {
        return Results.Json(new { error = "Please log in to continue." }, statusCode: StatusCodes.Status401Unauthorized);
    }
    if (!Regex.IsMatch(accountNumber, "^[0-9]{8}$", RegexOptions.CultureInvariant))
    {
        return Results.Json(new { error = "Enter an 8-digit account number." }, statusCode: StatusCodes.Status400BadRequest);
    }

    var profile = await store.GetProfileAsync(accountNumber, context.RequestAborted);
    if (profile is null)
    {
        return Results.Json(new { error = "No account has that number. Check it and try again." }, statusCode: StatusCodes.Status404NotFound);
    }
    if (profile.Id == account.Id)
    {
        return Results.Json(new { error = "That is your own account number." }, statusCode: StatusCodes.Status400BadRequest);
    }
    return Results.Json(profile);
}).RequireRateLimiting("profile-lookup");

app.MapGet("/api/chats", async (HttpContext context, PersistentChatStore store) =>
{
    var account = await GetCurrentAccountAsync(context, store);
    return account is null
        ? Results.Json(new { error = "Please log in to continue." }, statusCode: StatusCodes.Status401Unauthorized)
        : Results.Json(await store.GetChatsAsync(account, context.RequestAborted));
});

app.MapGet("/api/chats/{accountNumber}/messages", async (
    string accountNumber,
    HttpContext context,
    PersistentChatStore store,
    RealtimeHub hub) =>
{
    var account = await GetCurrentAccountAsync(context, store);
    if (account is null)
    {
        return Results.Json(new { error = "Please log in to continue." }, statusCode: StatusCodes.Status401Unauthorized);
    }

    var conversation = await store.GetMessagesAsync(account, accountNumber, context.RequestAborted);
    if (conversation is null)
    {
        return Results.Json(new { error = "That account could not be found." }, statusCode: StatusCodes.Status404NotFound);
    }

    if (conversation.MarkedAsRead)
    {
        var senderIds = conversation.Messages
            .Where(message => message.SenderId != account.Id && message.ReadAt is not null)
            .Select(message => message.SenderId)
            .Distinct(StringComparer.Ordinal);
        foreach (var senderId in senderIds)
        {
            hub.Publish(senderId, new { type = "messages-read", accountNumber = account.AccountNumber });
        }
    }
    return Results.Json(conversation.Messages);
});

app.MapPost("/api/chats/{accountNumber}/messages", async (
    string accountNumber,
    MessageRequest request,
    HttpContext context,
    PersistentChatStore store,
    RealtimeHub hub,
    ILogger<Program> logger) =>
{
    var sender = await GetCurrentAccountAsync(context, store);
    if (sender is null)
    {
        return Results.Json(new { error = "Please log in to continue." }, statusCode: StatusCodes.Status401Unauthorized);
    }
    if (!Regex.IsMatch(accountNumber, "^[0-9]{8}$", RegexOptions.CultureInvariant))
    {
        return Results.Json(new { error = "Enter an 8-digit account number." }, statusCode: StatusCodes.Status400BadRequest);
    }
    var text = request.Text?.Trim();
    if (string.IsNullOrEmpty(text) || text.Length > 2000)
    {
        return Results.Json(new { error = "Messages must contain 1 to 2000 characters." }, statusCode: StatusCodes.Status400BadRequest);
    }

    var (message, recipient) = await store.SendMessageAsync(
        sender,
        accountNumber,
        text,
        context.RequestAborted);
    if (message is null || recipient is null)
    {
        return Results.Json(new { error = "The recipient account was not found." }, statusCode: StatusCodes.Status404NotFound);
    }

    hub.Publish(recipient.Id, new
    {
        type = "message",
        messageId = message.Id,
        senderId = sender.Id,
        senderName = sender.Name,
        senderAccountNumber = sender.AccountNumber,
        preview = text.Length > 120 ? $"{text[..117]}..." : text
    });
    hub.Publish(sender.Id, new { type = "chat-changed" });

    var requestToken = app.Lifetime.ApplicationStopping;
    _ = Task.Run(async () =>
    {
        try
        {
            await pushSender.SendAsync(sender, recipient, text, requestToken);
        }
        catch (Exception error) when (error is IOException or OperationCanceledException or HttpRequestException)
        {
            logger.LogWarning(error, "A push notification could not be delivered for message {MessageId}.", message.Id);
        }
    }, CancellationToken.None);

    return Results.Json(message, statusCode: StatusCodes.Status201Created);
});

app.MapGet("/api/events", async (
    HttpContext context,
    PersistentChatStore store,
    RealtimeHub hub) =>
{
    var account = await GetCurrentAccountAsync(context, store, context.RequestAborted);
    if (account is null)
    {
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        await context.Response.WriteAsJsonAsync(
            new { error = "Please log in to receive messages." },
            context.RequestAborted);
        return;
    }

    context.Response.StatusCode = StatusCodes.Status200OK;
    context.Response.Headers.ContentType = "text/event-stream";
    context.Response.Headers.CacheControl = "no-cache,no-transform";
    context.Response.Headers["X-Accel-Buffering"] = "no";
    var channel = Channel.CreateBounded<string>(new BoundedChannelOptions(64)
    {
        FullMode = BoundedChannelFullMode.DropOldest,
        SingleReader = true,
        SingleWriter = false
    });
    using var subscription = hub.Subscribe(account.Id, channel);
    await using var writer = new StreamWriter(
        context.Response.Body,
        new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
        bufferSize: 1024,
        leaveOpen: true);

    await writer.WriteAsync("data: {\"type\":\"ready\"}\n\n");
    await writer.FlushAsync(context.RequestAborted);
    while (!context.RequestAborted.IsCancellationRequested)
    {
        var available = channel.Reader.WaitToReadAsync(context.RequestAborted).AsTask();
        var heartbeat = Task.Delay(TimeSpan.FromSeconds(20), context.RequestAborted);
        if (await Task.WhenAny(available, heartbeat) == heartbeat)
        {
            await writer.WriteAsync(": keep-alive\n\n");
            await writer.FlushAsync(context.RequestAborted);
            continue;
        }
        if (!await available)
        {
            break;
        }
        while (channel.Reader.TryRead(out var notification))
        {
            await writer.WriteAsync($"data: {notification}\n\n");
        }
        await writer.FlushAsync(context.RequestAborted);
    }
});

app.MapGet("/api/notifications/public-key", (WebPushSender sender) =>
    Results.Json(new { publicKey = sender.PublicKey }));

app.MapPost("/api/notifications/subscribe", async (
    PushSubscribeRequest request,
    HttpContext context,
    PersistentChatStore store) =>
{
    var account = await GetCurrentAccountAsync(context, store);
    if (account is null)
    {
        return Results.Json(new { error = "Please log in to enable notifications." }, statusCode: StatusCodes.Status401Unauthorized);
    }

    var endpoint = request.Endpoint?.Trim();
    var p256dh = request.Keys?.P256dh;
    var auth = request.Keys?.Auth;
    if (!IsAllowedPushEndpoint(endpoint)
        || !IsBase64UrlKey(p256dh, 65)
        || !IsBase64UrlKey(auth, 16))
    {
        return Results.Json(
            new { error = "The browser provided an invalid notification subscription. Please try enabling notifications again." },
            statusCode: StatusCodes.Status400BadRequest);
    }

    await store.SavePushSubscriptionAsync(
        account,
        new PushSubscriptionRecord(endpoint!, p256dh!, auth!),
        context.RequestAborted);
    return Results.NoContent();
});

app.Run();

static CookieOptions SessionCookieOptions(HttpContext context, bool isDevelopment) => new()
{
    HttpOnly = true,
    Secure = context.Request.IsHttps || !isDevelopment,
    SameSite = SameSiteMode.Strict,
    Path = "/",
    IsEssential = true,
    MaxAge = TimeSpan.FromDays(30)
};

static void WriteSessionCookie(HttpContext context, string token, bool isDevelopment) =>
    context.Response.Cookies.Append(
        "mingle_session",
        token,
        SessionCookieOptions(context, isDevelopment));

static Task<AccountRecord?> GetCurrentAccountAsync(
    HttpContext context,
    PersistentChatStore store,
    CancellationToken cancellationToken = default) =>
    store.GetSessionAccountAsync(context.Request.Cookies["mingle_session"], cancellationToken);

static bool IsAllowedPushEndpoint(string? endpoint)
{
    if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri)
        || uri.Scheme != Uri.UriSchemeHttps
        || !string.IsNullOrEmpty(uri.UserInfo)
        || !string.IsNullOrEmpty(uri.Fragment))
    {
        return false;
    }

    var host = uri.Host;
    return host.Equals("fcm.googleapis.com", StringComparison.OrdinalIgnoreCase)
        || host.EndsWith(".fcm.googleapis.com", StringComparison.OrdinalIgnoreCase)
        || host.Equals("push.services.mozilla.com", StringComparison.OrdinalIgnoreCase)
        || host.EndsWith(".push.services.mozilla.com", StringComparison.OrdinalIgnoreCase)
        || host.Equals("push.apple.com", StringComparison.OrdinalIgnoreCase)
        || host.EndsWith(".push.apple.com", StringComparison.OrdinalIgnoreCase)
        || host.Equals("notify.windows.com", StringComparison.OrdinalIgnoreCase)
        || host.EndsWith(".notify.windows.com", StringComparison.OrdinalIgnoreCase);
}

static bool IsBase64UrlKey(string? value, int expectedSize)
{
    if (string.IsNullOrWhiteSpace(value)
        || value.Length > 180
        || !Regex.IsMatch(value, "^[A-Za-z0-9_-]+$", RegexOptions.CultureInvariant))
    {
        return false;
    }

    try
    {
        var standard = value.Replace('-', '+').Replace('_', '/');
        standard = standard.PadRight(standard.Length + (4 - standard.Length % 4) % 4, '=');
        return Convert.FromBase64String(standard).Length == expectedSize;
    }
    catch (FormatException)
    {
        return false;
    }
}
