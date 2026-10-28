"use strict";

const SHELL_CACHE = "mingle-chat-pages-v5";
const APP_BASE = new URL("./", self.location.href);
const APP_SHELL = ["", "index.html", "styles.css", "app.js?v=20261028-4", "manifest.json", "icon.svg"]
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
