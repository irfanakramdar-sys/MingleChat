"use strict";

const SHELL_CACHE = "mingle-server-chat-v1";
const APP_SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/manifest.json", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith("mingle-") && key !== SHELL_CACHE).map((key) => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;
  if (event.request.headers.get("Accept")?.includes("text/event-stream")) return;

  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok && response.type === "basic") {
      const copy = response.clone();
      caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy)).catch((error) => {
        console.error("Could not update the offline app shell:", error);
      });
    }
    return response;
  }).catch(async (error) => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    throw error;
  }));
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch (error) {
    console.error("Could not read the incoming push notification:", error);
    return;
  }

  event.waitUntil(self.registration.showNotification(payload.title || "New Mingle message", {
    body: payload.body || "You have a new message.",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: payload.tag || `mingle-${payload.accountNumber}`,
    renotify: true,
    data: { accountNumber: payload.accountNumber }
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL("/", self.location.origin);
  if (event.notification.data?.accountNumber) {
    target.searchParams.set("chat", event.notification.data.accountNumber);
  }
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      existing.postMessage({
        type: "OPEN_CHAT",
        accountNumber: event.notification.data?.accountNumber
      });
      return existing.focus();
    }
    return self.clients.openWindow(target.toString());
  }));
});
