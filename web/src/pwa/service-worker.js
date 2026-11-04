// Offline cache for 象棋教練. Plain JS (no imports): the build fills in the three constants below
// and writes the result to <dist>/sw.js. The version is a hash of every precached file, so any
// change to the build gives a new cache name; activate then deletes the old ones.
const VERSION = "__SW_VERSION__";
const PRECACHE_URLS = __SW_URLS__;
const BASE = "__SW_BASE__";

const CACHE_PREFIX = "xiangqi-coach-";
const PRECACHE_PREFIX = `${CACHE_PREFIX}precache-`;
const CACHE_NAME = `${PRECACHE_PREFIX}${VERSION}`;
const ORIGIN = self.location.origin;

function keyOf(url) {
  const u = new URL(url, ORIGIN);
  u.search = "";
  u.hash = "";
  return u.href;
}

// No automatic skipWaiting on purpose: an open tab keeps its own matching version of the page,
// workers and wasm until every tab is closed; the new version then takes over on the next visit.
// The page shows a "new version" banner when a worker is waiting; only if the user presses its
// button does the page post {type:"skip-waiting"} (handled below) and reload onto the new version.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(PRECACHE_URLS.map((u) => new Request(new URL(u, ORIGIN).href, { cache: "reload" }))),
    ),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "skip-waiting") self.skipWaiting();
});

// The previous version's cache is kept (everything older is deleted). A tab still running the previous
// page (it never pressed "update", but another tab did) keeps asking for the previous hashed files; the
// current cache no longer has them, so fetch falls back to the previous cache before the network.
// "Previous" = the precache cache created just before this one: CacheStorage.keys() lists names in
// creation order (per spec), so no extra meta storage is needed. If this cache is first, there is none.
async function previousCacheName() {
  const names = (await caches.keys()).filter((n) => n.startsWith(PRECACHE_PREFIX));
  const i = names.indexOf(CACHE_NAME);
  return i > 0 ? names[i - 1] : null;
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    previousCacheName()
      .then(async (previous) => {
        const names = await caches.keys();
        await Promise.all(
          names.filter((n) => n.startsWith(PRECACHE_PREFIX) && n !== CACHE_NAME && n !== previous).map((n) => caches.delete(n)),
        );
      })
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== ORIGIN) return;
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const hit = await cache.match(keyOf(request.url));
      if (hit) return hit;
      const previous = await previousCacheName();
      if (previous) {
        const old = await (await caches.open(previous)).match(keyOf(request.url));
        if (old) return old;
      }
      if (request.mode === "navigate" && url.pathname.startsWith(BASE)) {
        const page = await cache.match(keyOf(BASE));
        if (page) return page;
      }
      return fetch(request);
    }),
  );
});
