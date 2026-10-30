// App shell cache so the dashboard opens instantly. Data comes live from Firebase, never cached here.
const CACHE = "energy-shell-v59";
const SHELL = ["./", "manifest.webmanifest", "icon.svg", "icon-192.png", "firebase-config.js", "app.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never touch cross-origin (Firebase SDK, Google sign-in) or the auth handler under /__/.
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/__/")) return;
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then((r) => {
    const copy = r.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));
});
