using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;

namespace Mingle.Server;

internal sealed class RealtimeHub
{
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, Channel<string>>> _accounts =
        new(StringComparer.Ordinal);
    private readonly JsonSerializerOptions _serializerOptions = new(JsonSerializerDefaults.Web);

    public IDisposable Subscribe(string userId, Channel<string> channel)
    {
        var subscriptionId = Guid.NewGuid().ToString("N");
        var subscriptions = _accounts.GetOrAdd(
            userId,
            _ => new ConcurrentDictionary<string, Channel<string>>(StringComparer.Ordinal));
        subscriptions[subscriptionId] = channel;
        return new HubSubscription(this, userId, subscriptionId);
    }

    public void Publish(string userId, object notification)
    {
        if (!_accounts.TryGetValue(userId, out var subscriptions))
        {
            return;
        }

        var json = JsonSerializer.Serialize(notification, _serializerOptions);
        foreach (var channel in subscriptions.Values)
        {
            channel.Writer.TryWrite(json);
        }
    }

    private void Remove(string userId, string subscriptionId)
    {
        if (!_accounts.TryGetValue(userId, out var subscriptions))
        {
            return;
        }

        if (subscriptions.TryRemove(subscriptionId, out var channel))
        {
            channel.Writer.TryComplete();
        }

        if (subscriptions.IsEmpty)
        {
            _accounts.TryRemove(new KeyValuePair<string, ConcurrentDictionary<string, Channel<string>>>(
                userId,
                subscriptions));
        }
    }

    private sealed class HubSubscription(RealtimeHub hub, string userId, string subscriptionId) : IDisposable
    {
        public void Dispose() => hub.Remove(userId, subscriptionId);
    }
}
