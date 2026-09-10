/**
 * Servis calisani — yalnizca uygulama kabugunu onbellege alir.
 *
 * Amaci hiz ve "ana ekrana ekle" ile kurulabilirlik. Medya istekleri, API
 * cagrilari ve 32 MB'lik FFmpeg cekirdegi bilerek disarida birakilir: bunlari
 * araya girmeden gecirmek hem bellek hem de dogruluk acisindan daha guvenli
 * (Range istekleri ve buyuk govdeler onbelleklenmemeli).
 */

// Surum degisince eski onbellek tumden silinir (activate icinde).
const CACHE = "avd-shell-v2";
const SHELL = [
  "/",
  "/index.html",
  "/assets/app.css",
  "/assets/app.js",
  "/assets/engine.js",
  "/assets/ffmpeg.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // hedef sitelerin baytlari
  if (url.pathname.startsWith("/api/")) return; // cozumleme ve aktarim
  if (url.pathname.startsWith("/vendor/")) return; // FFmpeg cekirdegi
  if (request.headers.has("range")) return; // parcali indirmeler

  // Sayfa gezintisi: once agdan dene, cevrimdisiysa kabugu ver.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("/index.html").then((r) => r ?? Response.error())),
    );
    return;
  }

  // Kabuk dosyalari: ONCE AG, sonra onbellek.
  //
  // Once onbellek vermek daha hizli gorunur ama yanlistir: bir duzeltme
  // yayimlandiginda kullanici eski CSS/JS ile kalir ve ancak ikinci acilista
  // yenisini gorur. Site zaten ag olmadan is yapamadigi icin dogru davranis,
  // agi denemek ve yalnizca cevrimdisiyken onbellege dusmektir.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached ?? Response.error())),
  );
});
