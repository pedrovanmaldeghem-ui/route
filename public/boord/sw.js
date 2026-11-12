/* Buspilot service worker — maakt de boordcomputer installeerbaar en bruikbaar zonder signaal.
   De app-schil wordt bewaard (de netten zelf komen via /api en worden niet gecachet). Kaarttegels beheert de app zelf (eigen cache),
   dus die raken we hier niet aan. */
const CACHE = "buspilot-eigen-v2";
const SCHIL = [
  "./",
  "manifest.json",
  "modus.js",
  "/img/bp-180.png", "/img/bp-192.png", "/img/bp-512.png",
  "/img/favicon-32.png", "/img/favicon-16.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://unpkg.com/leaflet-rotate@0.2.8/dist/leaflet-rotate.js"
];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.allSettled(SCHIL.map(u => c.add(new Request(u, { cache: "reload" }))));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => (k.startsWith("buspilot-") || k.startsWith("rebootpro-")) && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Navigatie (de pagina zelf): netwerk eerst, val offline terug op de bewaarde app-pagina.
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      try { return await fetch(req); }
      catch { return (await caches.match("./")) || (await caches.match(req)) || Response.error(); }
    })());
    return;
  }

  // Login- en omleidingsinfo: altijd vers ophalen, nooit uit cache.
  if (url.pathname.startsWith("/api/")) return;
  // Kaarttegels: de app cachet die zelf, niet dubbel bewaren.
  if (url.hostname.endsWith("tile.openstreetmap.org")) return;

  // Overige (dienstregeling, lijn-/stelplaatsbestanden, leaflet): cache-first, op achtergrond verversen.
  e.respondWith((async () => {
    const cached = await caches.match(req);
    const net = fetch(req).then(r => {
      if (r && r.ok && (url.origin === self.location.origin || url.hostname === "unpkg.com")) {
        caches.open(CACHE).then(c => c.put(req, r.clone())).catch(() => {});
      }
      return r;
    }).catch(() => null);
    return cached || (await net) || Response.error();
  })());
});
