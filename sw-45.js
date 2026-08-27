const CACHE = "home-gym-v45";
const SHELL = [
  "./index.html",
  "./app.js",
  "./coach.js",
  "./data.js",
  "./restore-data.js",
  "./styles.css",
  "./manifest.webmanifest",
  "./icon-180.png",
  "./icon-192.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL).catch(() => {})));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

/**
 * ネットワーク優先 + キャッシュ退避。
 * - オンライン時は必ずネットワークを先に試すので、古い版で固まることはない。
 * - 取得できたら控えを保存し、Macに繋がらない時はその控えで起動する。
 * index.html はスクリプトを `./app.js?t=<時刻>` と毎回違うURLで読むため、
 * キャッシュのキーはクエリを除いた pathname に正規化する（これをしないと
 * 退避したファイルに二度とヒットしない）。
 */
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const key = url.pathname;

  event.respondWith(
    fetch(event.request, { cache: "no-store" })
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches
            .open(CACHE)
            .then((cache) => cache.put(key, copy))
            .catch(() => {});
        }
        return response;
      })
      .catch(() =>
        caches.match(key).then((hit) => {
          if (hit) return hit;
          // 画面遷移だけは index.html で受け止める。JS/CSS に HTML を返すと壊れるので返さない。
          if (event.request.mode === "navigate") return caches.match("./index.html");
          return Response.error();
        })
      )
  );
});
