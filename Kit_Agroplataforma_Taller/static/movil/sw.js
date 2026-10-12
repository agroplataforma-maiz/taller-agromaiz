/* Service worker: guarda la app para que abra sin conexión. Las llamadas a /api siempre van a la red. */
const CACHE = "agro-campo-v1";
const ARCHIVOS = ["/movil/", "/movil/index.html", "/movil/app.js", "/movil/app.css", "/movil/manifest.webmanifest", "/movil/icono.svg", "/movil/icono-192.png", "/movil/icono-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/movil/")) {
    // red primero (para recibir actualizaciones), caché si no hay señal
    e.respondWith(fetch(e.request).then((r) => { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("/movil/index.html"))));
  }
});
