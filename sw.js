/**
 * ============================================================================
 * 檔案名稱：sw.js
 * 整體程式說明：
 *   Service Worker 離線快取管理模組（v1.1.5），負責：
 *   1. 在 install 階段快取 PWA 靜態外殼（HTML / manifest / JS 模組），確保離線可啟動。
 *   2. 在 activate 階段清除舊版快取（v1.1.0 ~ v1.1.4），讓 GitHub Pages 部署新版後即時生效。
 *   3. 靜態資源採 Network-First（連線優先、離線回退快取）策略，避免手機被舊版快取卡住；
 *      同時放行所有 GAS Web App（script.google.com）及含 token 參數之同步請求。
 * ============================================================================
 */

const CACHE_VERSION = 'trip-pwa-shell-v1.1.5';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './idbStore.js',
  './syncService.js',
  './scheduleEngine.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const urlStr = req.url || '';
  if (urlStr.indexOf('script.google.com') !== -1 ||
      urlStr.indexOf('token=') !== -1 ||
      urlStr.indexOf('read_token=') !== -1) {
    return;
  }

  if (req.url.startsWith(self.location.origin)) {
    event.respondWith(
      fetch(req).then((networkResp) => {
        if (networkResp && networkResp.status === 200) {
          const clone = networkResp.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
        }
        return networkResp;
      }).catch(() => {
        return caches.match(req, { ignoreSearch: true }).then((cached) => {
          if (cached) return cached;
          if (req.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('離線且尚無快取資源', { status: 503, statusText: 'Service Unavailable' });
        });
      })
    );
  }
});
