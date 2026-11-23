"use strict";

const SHELL_CACHE = "mingle-chat-pages-v12";
const APP_BASE = new URL("./", self.location.href);
const APP_SHELL = ["", "index.html", "styles.css?v=20261123-4", "app.js?v=20261123-4", "manifest.json", "icon.svg"]
  .map((path) => new URL(path, APP_BASE).toString());

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith("mingle-chat-") && key !== SHELL_CACHE).map((key) => caches.delete(key))
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
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch (error) {
    console.error("Could not parse a push notification:", error);
  }
  const isCall = payload.kind === "incoming-call";
  event.waitUntil(self.registration.showNotification(payload.title || "Mingle Chat", {
    body: payload.body || (isCall ? "Incoming call" : "You have a new message"),
    icon: "./icon.svg",
    tag: payload.tag || `mingle-${payload.callId || payload.chat || "notification"}`,
    requireInteraction: isCall,
    silent: false,
    vibrate: isCall ? [350, 160, 350, 160, 500] : [180, 90, 180],
    data: {
      kind: payload.kind || "message",
      callId: payload.callId || null,
      chat: payload.chat || null,
      groupId: payload.groupId || null
    }
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const destination = new URL("./", self.location.href);
  if (data.callId) destination.searchParams.set("call", data.callId);
  else if (data.groupId) destination.searchParams.set("group", data.groupId);
  else if (data.chat) destination.searchParams.set("chat", data.chat);
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      return existing.navigate(destination.href).then(() => existing.focus());
    }
    return self.clients.openWindow(destination.href);
  }));
});
