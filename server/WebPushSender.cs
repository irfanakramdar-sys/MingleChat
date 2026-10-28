using System.Buffers.Binary;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Mingle.Server;

internal sealed class WebPushSender : IDisposable
{
    private const int PublicKeySize = 65;
    private const int AuthSecretSize = 16;
    private const int SaltSize = 16;
    private const int AuthenticatedEncryptionTagSize = 16;
    private static readonly byte[] WebPushInfoPrefix = Encoding.UTF8.GetBytes("WebPush: info\0");
    private static readonly byte[] ContentEncryptionInfo = Encoding.UTF8.GetBytes("Content-Encoding: aes128gcm\0");
    private static readonly byte[] NonceInfo = Encoding.UTF8.GetBytes("Content-Encoding: nonce\0");
    private readonly PersistentChatStore _store;
    private readonly ILogger<WebPushSender> _logger;
    private readonly HttpClient _httpClient = new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        ConnectTimeout = TimeSpan.FromSeconds(8),
        PooledConnectionLifetime = TimeSpan.FromMinutes(5)
    })
    {
        Timeout = TimeSpan.FromSeconds(12)
    };
    private readonly ECDsa _vapidKey;
    private readonly byte[] _vapidPublicKey;
    private readonly string _vapidSubject;

    public WebPushSender(
        PersistentChatStore store,
        string dataDirectory,
        string subject,
        ILogger<WebPushSender> logger)
    {
        _store = store;
        _logger = logger;
        _vapidSubject = subject;
        Directory.CreateDirectory(dataDirectory);
        var keyPath = Path.Combine(dataDirectory, "web-push-vapid.json");
        var parameters = LoadOrCreateKeys(keyPath);
        _vapidKey = ECDsa.Create(parameters);
        var publicParameters = _vapidKey.ExportParameters(includePrivateParameters: false);
        _vapidPublicKey = SerializePublicKey(publicParameters.Q.X!, publicParameters.Q.Y!);
    }

    public string PublicKey => Base64Url(_vapidPublicKey);

    public async Task SendAsync(
        AccountRecord sender,
        AccountRecord recipient,
        string message,
        CancellationToken cancellationToken)
    {
        var subscriptions = await _store.GetPushSubscriptionsAsync(recipient.Id, cancellationToken);
        if (subscriptions.Count == 0)
        {
            return;
        }

        var payload = JsonSerializer.SerializeToUtf8Bytes(new PushPayload(
            sender.Name,
            message.Length > 120 ? $"{message[..117]}..." : message,
            sender.AccountNumber,
            $"mingle-{sender.AccountNumber}"));

        foreach (var subscription in subscriptions)
        {
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, subscription.Endpoint);
                request.Version = HttpVersion.Version11;
                request.Headers.TryAddWithoutValidation(
                    "Authorization",
                    $"vapid t={CreateVapidToken(subscription.Endpoint)}, k={Base64Url(_vapidPublicKey)}");
                request.Headers.TryAddWithoutValidation("TTL", "86400");
                request.Content = new ByteArrayContent(Encrypt(payload, subscription));
                request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
                request.Content.Headers.ContentEncoding.Add("aes128gcm");

                using var response = await _httpClient.SendAsync(request, cancellationToken);
                if (response.IsSuccessStatusCode)
                {
                    continue;
                }

                _logger.LogWarning(
                    "Push delivery to {EndpointHost} failed with status {Status}.",
                    new Uri(subscription.Endpoint).Host,
                    (int)response.StatusCode);

                if (response.StatusCode is HttpStatusCode.Gone or HttpStatusCode.NotFound)
                {
                    await _store.RemovePushSubscriptionAsync(recipient.Id, subscription.Endpoint, cancellationToken);
                }
            }
            catch (Exception error) when (error is HttpRequestException
                or TaskCanceledException
                or CryptographicException
                or ArgumentException)
            {
                _logger.LogWarning(error, "Could not deliver a push notification to an account device.");
            }
        }
    }

    public void Dispose()
    {
        _vapidKey.Dispose();
        _httpClient.Dispose();
    }

    private byte[] Encrypt(byte[] payload, PushSubscriptionRecord subscription)
    {
        var clientPublicBytes = DecodeBase64Url(subscription.P256dh);
        var authSecret = DecodeBase64Url(subscription.Auth);
        if (clientPublicBytes.Length != PublicKeySize || authSecret.Length != AuthSecretSize)
        {
            throw new CryptographicException("The saved notification subscription key has an invalid size.");
        }

        var clientPublicParameters = new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            Q = new ECPoint
            {
                X = clientPublicBytes[1..33],
                Y = clientPublicBytes[33..]
            }
        };
        using var clientKey = ECDiffieHellman.Create();
        clientKey.ImportParameters(clientPublicParameters);
        using var senderKey = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        var senderPublicParameters = senderKey.ExportParameters(includePrivateParameters: false);
        var senderPublicBytes = SerializePublicKey(senderPublicParameters.Q.X!, senderPublicParameters.Q.Y!);
        var sharedSecret = senderKey.DeriveRawSecretAgreement(clientKey.PublicKey);

        var keyInfo = Combine(
            WebPushInfoPrefix,
            clientPublicBytes,
            senderPublicBytes,
            new byte[] { 1 });
        var inputKeyMaterial = HkdfExpand(Hmac(authSecret, sharedSecret), keyInfo, 32);
        var salt = RandomNumberGenerator.GetBytes(SaltSize);
        var pseudorandomKey = Hmac(salt, inputKeyMaterial);
        var contentKey = HkdfExpand(pseudorandomKey, ContentEncryptionInfo, 16);
        var nonce = HkdfExpand(pseudorandomKey, NonceInfo, 12);

        var paddedPayload = new byte[payload.Length + 1];
        payload.CopyTo(paddedPayload, 0);
        paddedPayload[^1] = 2;
        var encrypted = new byte[paddedPayload.Length + AuthenticatedEncryptionTagSize];
        using (var cipher = new AesGcm(contentKey, AuthenticatedEncryptionTagSize))
        {
            cipher.Encrypt(nonce, paddedPayload, encrypted.AsSpan(0, paddedPayload.Length), encrypted.AsSpan(paddedPayload.Length));
        }

        var result = new byte[SaltSize + 4 + 1 + senderPublicBytes.Length + encrypted.Length];
        var offset = 0;
        salt.CopyTo(result, offset);
        offset += SaltSize;
        BinaryPrimitives.WriteUInt32BigEndian(result.AsSpan(offset, 4), 4096);
        offset += 4;
        result[offset++] = (byte)senderPublicBytes.Length;
        senderPublicBytes.CopyTo(result, offset);
        offset += senderPublicBytes.Length;
        encrypted.CopyTo(result, offset);
        return result;
    }

    private string CreateVapidToken(string endpoint)
    {
        var uri = new Uri(endpoint);
        var issuedAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var header = Base64Url(Encoding.UTF8.GetBytes("""{"typ":"JWT","alg":"ES256"}"""));
        var claims = JsonSerializer.SerializeToUtf8Bytes(new VapidClaims(
            uri.GetLeftPart(UriPartial.Authority),
            issuedAt + 43_200,
            _vapidSubject));
        var unsignedToken = $"{header}.{Base64Url(claims)}";
        var signature = _vapidKey.SignData(
            Encoding.ASCII.GetBytes(unsignedToken),
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        return $"{unsignedToken}.{Base64Url(signature)}";
    }

    private static ECParameters LoadOrCreateKeys(string path)
    {
        if (File.Exists(path))
        {
            var saved = JsonSerializer.Deserialize<VapidKeyFile>(File.ReadAllText(path))
                ?? throw new InvalidDataException("The saved web push server key could not be read.");
            return new ECParameters
            {
                Curve = ECCurve.NamedCurves.nistP256,
                Q = new ECPoint
                {
                    X = Convert.FromBase64String(saved.X),
                    Y = Convert.FromBase64String(saved.Y)
                },
                D = Convert.FromBase64String(saved.D)
            };
        }

        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var parameters = key.ExportParameters(includePrivateParameters: true);
        var keyFile = new VapidKeyFile(
            Convert.ToBase64String(parameters.Q.X!),
            Convert.ToBase64String(parameters.Q.Y!),
            Convert.ToBase64String(parameters.D!));
        var temporaryPath = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllText(temporaryPath, JsonSerializer.Serialize(keyFile));
            File.Move(temporaryPath, path);
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }

        return parameters;
    }

    private static byte[] SerializePublicKey(byte[] x, byte[] y)
    {
        var publicKey = new byte[PublicKeySize];
        publicKey[0] = 4;
        x.CopyTo(publicKey, 1);
        y.CopyTo(publicKey, 1 + x.Length);
        return publicKey;
    }

    private static byte[] Hmac(byte[] key, byte[] value)
    {
        using var hmac = new HMACSHA256(key);
        return hmac.ComputeHash(value);
    }

    private static byte[] HkdfExpand(byte[] pseudorandomKey, byte[] info, int outputLength)
    {
        var output = new byte[outputLength];
        var previousBlock = Array.Empty<byte>();
        var offset = 0;
        byte counter = 1;
        while (offset < outputLength)
        {
            var block = Hmac(pseudorandomKey, Combine(previousBlock, info, new[] { counter++ }));
            var bytesToCopy = Math.Min(block.Length, outputLength - offset);
            block.AsSpan(0, bytesToCopy).CopyTo(output.AsSpan(offset));
            offset += bytesToCopy;
            previousBlock = block;
        }
        return output;
    }

    private static byte[] Combine(params byte[][] arrays)
    {
        var totalLength = arrays.Sum(bytes => bytes.Length);
        var result = new byte[totalLength];
        var offset = 0;
        foreach (var bytes in arrays)
        {
            bytes.CopyTo(result, offset);
            offset += bytes.Length;
        }
        return result;
    }

    private static byte[] DecodeBase64Url(string value)
    {
        var padded = value.Replace('-', '+').Replace('_', '/');
        padded = padded.PadRight(padded.Length + (4 - padded.Length % 4) % 4, '=');
        return Convert.FromBase64String(padded);
    }

    private static string Base64Url(byte[] value) =>
        Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private sealed record VapidClaims(string Aud, long Exp, string Sub);

    private sealed record VapidKeyFile(string X, string Y, string D);

    private sealed record PushPayload(string Title, string Body, string AccountNumber, string Tag);
}
