/**
 * ============================================================================
 * 檔案名稱：sw.js
 * 整體程式說明：
 *   Service Worker 離線快取管理模組（v1.1.3），負責：
 *   1. 在 install 階段快取 PWA 靜態外殼（HTML / manifest / JS 模組），確保離線可啟動。
 *   2. 在 activate 階段清除舊版快取（如 v1.1.0 ~ v1.1.2），讓 GitHub Pages 部署新版後即時生效。
 *   3. 在 fetch 階段放行所有 GAS Web App（script.google.com）及含 token 參數之同步請求，
 *      絕不快取動態 API 回應。
 * ============================================================================
 */

const CACHE_VERSION = 'trip-pwa-shell-v1.1.3';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './idbStore.js',
  './syncService.js',
  './scheduleEngine.js'
];

/**
 * 安裝階段：預先快取靜態外殼檔案，並呼叫 skipWaiting() 跳過等待直接進入啟用階段。
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

/**
 * 啟用階段：刪除不屬於目前 CACHE_VERSION 的舊快取，並透過 clients.claim() 立即接管所有開啟分頁。
 */
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

/**
 * 請求攔截：
 * - 放行非 GET 請求（如 POST 發布進度）與 GAS 同步端點（script.google.com / 含 token 參數）。
 * - 靜態資源採 Cache-First 策略，未命中快取時向網路抓取並寫入當前版本快取；離線導覽時回退至 index.html。
 */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const urlStr = req.url || '';
  if (urlStr.indexOf('script.google.com') !== -1 ||
      urlStr.indexOf('token=') !== -1 ||
      urlStr.indexOf('read_token=') !== -1) {
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) {
        return cached;
      }
      return fetch(req).then((networkResp) => {
        if (networkResp && networkResp.status === 200 && req.url.startsWith(self.location.origin)) {
          const clone = networkResp.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
        }
        return networkResp;
      }).catch(() => {
        if (req.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return new Response('離線且尚無快取資源', { status: 503, statusText: 'Service Unavailable' });
      });
    })
  );
});
