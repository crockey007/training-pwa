const CACHE = "home-gym-v46";
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

// キャッシュが空のままオフラインになった時に出す画面。
// 何も返さないと真っ白になって原因が分からなくなるので、必ずこれを返す。
const FALLBACK_HTML = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Training</title><style>
body{margin:0;min-height:100dvh;background:#0b0d10;color:#f3f5f7;
font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;
display:flex;align-items:center;justify-content:center;padding:24px}
main{max-width:360px}h1{font-size:26px;margin:0 0 12px}
p{color:#8b95a5;line-height:1.65}
a.btn{display:block;margin-top:20px;border-radius:14px;padding:16px;background:#e53935;
color:#fff;font-size:17px;font-weight:800;text-align:center;text-decoration:none}
</style></head><body><main>
<h1>Training</h1>
<p>アプリのファイルがまだ端末に保存されていません。</p>
<p>Mac のサーバーを起動し、同じ Wi-Fi につないだ状態で一度開いてください。次からはオフラインでも起動します。</p>
<a class="btn" href="./index.html">再読み込み</a>
</main></body></html>`;

function fallbackResponse() {
  return new Response(FALLBACK_HTML, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

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
 * - 取得できたら控えを保存し、Mac に繋がらない時はその控えで起動する。
 *
 * 重要: respondWith() には必ず Response を渡すこと。undefined を渡すと
 * ナビゲーションが失敗して真っ白な画面になり、原因の分からない状態に陥る。
 *
 * index.html はスクリプトを `./app.js?t=<時刻>` と毎回違う URL で読むため、
 * キャッシュのキーはクエリを除いた pathname に正規化する（しないと退避に
 * 二度とヒットしない）。
 */
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const key = url.pathname;
  const isNavigate = event.request.mode === "navigate";

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
        caches
          .match(key)
          .then((hit) => hit || (isNavigate ? caches.match("./index.html") : null))
          .then((hit) => {
            if (hit) return hit;
            // 画面遷移は必ず何か表示する。JS/CSS に HTML を返すと壊れるのでエラーにする。
            return isNavigate ? fallbackResponse() : Response.error();
          })
          .catch(() => (isNavigate ? fallbackResponse() : Response.error()))
      )
  );
});
