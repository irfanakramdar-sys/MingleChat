using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Mingle.Server;

internal sealed class PersistentChatStore
{
    private readonly SemaphoreSlim _lock = new(1, 1);
    private readonly string _dataDirectory;
    private readonly string _storePath;
    private readonly string _subscriptionsPath;
    private readonly JsonSerializerOptions _jsonOptions = new(JsonSerializerDefaults.Web);
    private readonly ConcurrentDictionary<string, string> _sessions = new(StringComparer.Ordinal);
    private Dictionary<string, AccountRecord> _accounts = new(StringComparer.Ordinal);
    private Dictionary<string, List<ChatMessage>> _conversations = new(StringComparer.Ordinal);
    private Dictionary<string, List<PushSubscriptionRecord>> _pushSubscriptions = new(StringComparer.Ordinal);

    public PersistentChatStore(string dataDirectory)
    {
        _dataDirectory = Path.GetFullPath(dataDirectory);
        _storePath = Path.Combine(_dataDirectory, "chat-data.json");
        _subscriptionsPath = Path.Combine(_dataDirectory, "push-subscriptions.json");
    }

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        Directory.CreateDirectory(_dataDirectory);
        await _lock.WaitAsync(cancellationToken);
        try
        {
            if (File.Exists(_storePath))
            {
                var store = await ReadFileAsync<StoreFile>(_storePath, cancellationToken);
                _accounts = store.Accounts;
                _conversations = store.Conversations;
            }

            if (File.Exists(_subscriptionsPath))
            {
                _pushSubscriptions = await ReadFileAsync<Dictionary<string, List<PushSubscriptionRecord>>>(
                    _subscriptionsPath,
                    cancellationToken);
            }
        }
        finally
        {
            _lock.Release();
        }
    }

    public async Task<(AccountRecord? Account, bool PhoneAlreadyUsed)> CreateAccountAsync(
        string name,
        string phone,
        string password,
        CancellationToken cancellationToken)
    {
        await _lock.WaitAsync(cancellationToken);
        try
        {
            if (_accounts.ContainsKey(phone))
            {
                return (null, true);
            }

            var usedAccountNumbers = _accounts.Values
                .Select(account => account.AccountNumber)
                .ToHashSet(StringComparer.Ordinal);
            var accountNumber = CreateUniqueAccountNumber(usedAccountNumbers);
            var (salt, hash) = PasswordHasher.Create(password);
            var account = new AccountRecord(
                Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant(),
                name,
                phone,
                accountNumber,
                hash,
                salt,
                DateTimeOffset.UtcNow);

            _accounts.Add(phone, account);
            try
            {
                await SaveAccountsAsync(cancellationToken);
            }
            catch
            {
                _accounts.Remove(phone);
                throw;
            }
            return (account, false);
        }
        finally
        {
            _lock.Release();
        }
    }

    public async Task<AccountRecord?> ValidateLoginAsync(
        string phone,
        string password,
        CancellationToken cancellationToken)
    {
        AccountRecord? account;
        await _lock.WaitAsync(cancellationToken);
        try
        {
            _accounts.TryGetValue(phone, out account);
        }
        finally
        {
            _lock.Release();
        }

        return PasswordHasher.Verify(password, account?.PasswordSalt, account?.PasswordHash)
            ? account
            : null;
    }

    public string CreateSession(AccountRecord account)
    {
        var token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
        _sessions[token] = account.Id;
        return token;
    }

    public void RemoveSession(string? token)
    {
        if (!string.IsNullOrWhiteSpace(token))
        {
            _sessions.TryRemove(token, out _);
        }
    }

    public async Task<AccountRecord?> GetSessionAccountAsync(
        string? token,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(token) || !_sessions.TryGetValue(token, out var userId))
        {
            return null;
        }

        await _lock.WaitAsync(cancellationToken);
        try
        {
            return _accounts.Values.FirstOrDefault(account => account.Id == userId);
        }
        finally
        {
            _lock.Release();
        }
    }

    public async Task<PublicProfile?> GetProfileAsync(
        string accountNumber,
        CancellationToken cancellationToken)
    {
        await _lock.WaitAsync(cancellationToken);
        try
        {
            var account = _accounts.Values.FirstOrDefault(user =>
                string.Equals(user.AccountNumber, accountNumber, StringComparison.Ordinal));
            return account is null ? null : ToPublicProfile(account);
        }
        finally
        {
            _lock.Release();
        }
    }

    public async Task<IReadOnlyList<ChatSummary>> GetChatsAsync(
        AccountRecord account,
        CancellationToken cancellationToken)
    {
        await _lock.WaitAsync(cancellationToken);
        try
        {
            var summaries = new List<ChatSummary>();
            foreach (var other in _accounts.Values)
            {
                if (other.Id == account.Id)
                {
                    continue;
                }

                if (!_conversations.TryGetValue(ChatId(account.Id, other.Id), out var messages))
                {
                    continue;
                }

                var lastMessage = messages.Count == 0 ? null : messages[^1];
                var unread = messages.Count(message =>
                    message.SenderId != account.Id && message.ReadAt is null);
                summaries.Add(new ChatSummary(
                    other.AccountNumber,
                    other.Name,
                    other.Phone,
                    lastMessage?.Text ?? string.Empty,
                    lastMessage?.SenderId ?? string.Empty,
                    lastMessage?.CreatedAt ?? other.CreatedAt,
                    unread));
            }

            return summaries
                .OrderByDescending(chat => chat.UpdatedAt)
                .ToArray();
        }
        finally
        {
            _lock.Release();
        }
    }

    public async Task<ReadConversation?> GetMessagesAsync(
        AccountRecord account,
        string accountNumber,
        CancellationToken cancellationToken)
    {
        await _lock.WaitAsync(cancellationToken);
        try
        {
            var other = _accounts.Values.FirstOrDefault(candidate =>
                string.Equals(candidate.AccountNumber, accountNumber, StringComparison.Ordinal));
            if (other is null || other.Id == account.Id)
            {
                return null;
            }

            if (!_conversations.TryGetValue(ChatId(account.Id, other.Id), out var messages))
            {
                return new ReadConversation(Array.Empty<ChatMessage>(), false);
            }

            var unreadIndices = messages
                .Select((message, index) => (message, index))
                .Where(entry => entry.message.SenderId != account.Id && entry.message.ReadAt is null)
                .Select(entry => entry.index)
                .ToArray();
            if (unreadIndices.Length > 0)
            {
                var now = DateTimeOffset.UtcNow;
                foreach (var index in unreadIndices)
                {
                    messages[index] = messages[index] with { ReadAt = now };
                }
                await SaveAccountsAsync(cancellationToken);
            }

            return new ReadConversation(messages.TakeLast(300).ToArray(), unreadIndices.Length > 0);
        }
        finally
        {
            _lock.Release();
        }
    }

    public async Task<(ChatMessage? Message, AccountRecord? Recipient)> SendMessageAsync(
        AccountRecord sender,
        string accountNumber,
        string text,
        CancellationToken cancellationToken)
    {
        await _lock.WaitAsync(cancellationToken);
        try
        {
            var recipient = _accounts.Values.FirstOrDefault(candidate =>
                string.Equals(candidate.AccountNumber, accountNumber, StringComparison.Ordinal));
            if (recipient is null || recipient.Id == sender.Id)
            {
                return (null, null);
            }

            var conversationId = ChatId(sender.Id, recipient.Id);
            if (!_conversations.TryGetValue(conversationId, out var messages))
            {
                messages = [];
                _conversations.Add(conversationId, messages);
            }

            var message = new ChatMessage(
                Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant(),
                text,
                sender.Id,
                DateTimeOffset.UtcNow,
                null);
            messages.Add(message);
            try
            {
                await SaveAccountsAsync(cancellationToken);
            }
            catch
            {
                messages.RemoveAt(messages.Count - 1);
                if (messages.Count == 0)
                {
                    _conversations.Remove(conversationId);
                }
                throw;
            }

            return (message, recipient);
        }
        finally
        {
            _lock.Release();
        }
    }

    public async Task SavePushSubscriptionAsync(
        AccountRecord account,
        PushSubscriptionRecord subscription,
        CancellationToken cancellationToken)
    {
        await _lock.WaitAsync(cancellationToken);
        try
        {
            if (!_pushSubscriptions.TryGetValue(account.Id, out var subscriptions))
            {
                subscriptions = [];
                _pushSubscriptions.Add(account.Id, subscriptions);
            }

            subscriptions.RemoveAll(existing => existing.Endpoint == subscription.Endpoint);
            subscriptions.Add(subscription);
            await WriteFileAtomicallyAsync(_subscriptionsPath, _pushSubscriptions, cancellationToken);
        }
        finally
        {
            _lock.Release();
        }
    }

    public async Task RemovePushSubscriptionAsync(
        string accountId,
        string endpoint,
        CancellationToken cancellationToken)
    {
        await _lock.WaitAsync(cancellationToken);
        try
        {
            if (!_pushSubscriptions.TryGetValue(accountId, out var subscriptions))
            {
                return;
            }

            if (subscriptions.RemoveAll(subscription => subscription.Endpoint == endpoint) > 0)
            {
                if (subscriptions.Count == 0)
                {
                    _pushSubscriptions.Remove(accountId);
                }
                await WriteFileAtomicallyAsync(_subscriptionsPath, _pushSubscriptions, cancellationToken);
            }
        }
        finally
        {
            _lock.Release();
        }
    }

    public async Task<IReadOnlyList<PushSubscriptionRecord>> GetPushSubscriptionsAsync(
        string accountId,
        CancellationToken cancellationToken)
    {
        await _lock.WaitAsync(cancellationToken);
        try
        {
            return _pushSubscriptions.TryGetValue(accountId, out var subscriptions)
                ? subscriptions.ToArray()
                : [];
        }
        finally
        {
            _lock.Release();
        }
    }

    public static PublicProfile ToPublicProfile(AccountRecord account) =>
        new(account.Id, account.Name, account.Phone, account.AccountNumber, account.CreatedAt);

    public static string ChatId(string firstId, string secondId)
    {
        var first = string.CompareOrdinal(firstId, secondId) < 0 ? firstId : secondId;
        var second = first == firstId ? secondId : firstId;
        return $"{first}_{second}";
    }

    private static string CreateUniqueAccountNumber(HashSet<string> existing)
    {
        const int minimum = 10_000_000;
        const int range = 90_000_000;
        for (var attempt = 0; attempt < 100; attempt++)
        {
            var candidate = RandomNumberGenerator.GetInt32(minimum, minimum + range)
                .ToString(System.Globalization.CultureInfo.InvariantCulture);
            if (!existing.Contains(candidate))
            {
                return candidate;
            }
        }
        throw new InvalidOperationException("Could not allocate a unique account number. Please try again.");
    }

    private async Task SaveAccountsAsync(CancellationToken cancellationToken)
    {
        var data = new StoreFile
        {
            Accounts = _accounts,
            Conversations = _conversations
        };
        await WriteFileAtomicallyAsync(_storePath, data, cancellationToken);
    }

    private async Task<T> ReadFileAsync<T>(string filePath, CancellationToken cancellationToken)
    {
        await using var stream = File.OpenRead(filePath);
        return await JsonSerializer.DeserializeAsync<T>(stream, _jsonOptions, cancellationToken)
            ?? throw new InvalidDataException($"Saved data file '{Path.GetFileName(filePath)}' is empty or invalid.");
    }

    private async Task WriteFileAtomicallyAsync<T>(
        string filePath,
        T value,
        CancellationToken cancellationToken)
    {
        var temporaryPath = $"{filePath}.{Guid.NewGuid():N}.tmp";
        try
        {
            await using (var stream = new FileStream(
                temporaryPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                16_384,
                FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await JsonSerializer.SerializeAsync(stream, value, _jsonOptions, cancellationToken);
                await stream.FlushAsync(cancellationToken);
            }

            File.Move(temporaryPath, filePath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
    }
}
