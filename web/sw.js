// Offline support (FR-10): keep the app and route data on the phone after the first visit.
const CACHE = "bigmoves-v2";
const SHELL = [
  "./", "index.html", "css/app.css", "js/app.js", "js/router.js", "js/timeModel.js", "js/search.js",
  "data/network.json", "data/time_model_v0.json", "manifest.webmanifest", "icon.svg",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Stale-while-revalidate for app files; map tiles go straight to the network.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.hostname.endsWith("tile.openstreetmap.org")) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(e.request, { ignoreSearch: url.origin === location.origin });
    const fresh = fetch(e.request).then((res) => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
