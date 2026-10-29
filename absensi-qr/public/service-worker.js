/* Service worker QR Absensi — sengaja MINIMAL.
 * Prinsip: jangan pernah menyimpan cache untuk /api/* (data absensi harus selalu real-time,
 * cache basi di sini bisa bikin petugas lihat status kehadiran yang salah). Cuma file statis
 * (HTML/CSS/JS/ikon) yang di-cache, itu pun strategi "network-first" supaya update kode
 * langsung kepakai begitu online, dan cache cuma jadi cadangan saat benar-benar offline. */
'use strict';
const CACHE_NAME = 'qr-absensi-shell-v1';
const SHELL_FILES = [
  '/', '/index.html', '/script.js', '/styles.css', '/manifest.json',
  '/vendor/qr-encoder.js', '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => { /* offline saat install pertama, abaikan */ }),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Jangan sentuh sama sekali: API, upload foto/logo, dan request lintas origin (CDN scanner, dll).
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) {
    return;
  }
  if (req.method !== 'GET') return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('/index.html'))),
  );
});
