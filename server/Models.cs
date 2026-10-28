namespace Mingle.Server;

public sealed record RegisterRequest(string? Name, string? Phone, string? Password);

public sealed record LoginRequest(string? Phone, string? Password);

public sealed record MessageRequest(string? Text);

public sealed record PushSubscribeRequest(string? Endpoint, PushKeyRequest? Keys);

public sealed record PushKeyRequest(string? P256dh, string? Auth);

public sealed record AccountRecord(
    string Id,
    string Name,
    string Phone,
    string AccountNumber,
    string PasswordHash,
    string PasswordSalt,
    DateTimeOffset CreatedAt);

public sealed record PublicProfile(
    string Id,
    string Name,
    string Phone,
    string AccountNumber,
    DateTimeOffset CreatedAt);

public sealed record ChatMessage(
    string Id,
    string Text,
    string SenderId,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ReadAt);

public sealed record ChatSummary(
    string AccountNumber,
    string Name,
    string Phone,
    string LastMessage,
    string LastSenderId,
    DateTimeOffset UpdatedAt,
    int Unread);

public sealed record ReadConversation(
    IReadOnlyList<ChatMessage> Messages,
    bool MarkedAsRead);

public sealed record PushSubscriptionRecord(
    string Endpoint,
    string P256dh,
    string Auth);

internal sealed class StoreFile
{
    public Dictionary<string, AccountRecord> Accounts { get; set; } = new(StringComparer.Ordinal);

    public Dictionary<string, List<ChatMessage>> Conversations { get; set; } = new(StringComparer.Ordinal);
}
