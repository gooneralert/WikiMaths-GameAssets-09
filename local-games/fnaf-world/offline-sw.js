/* Offline resource mapper. One service worker serves every mirrored game;
   it reads the game's mirror-map.json and rewrites original URLs to local files. */
const BASE_URL = new URL("./", self.registration.scope);
const BASE_PATH = BASE_URL.pathname;
const MAP_URL = new URL("mirror-map.json", BASE_URL).href;
const PASSTHROUGH = [
  `${BASE_PATH}offline-sw.js`,
  `${BASE_PATH}__offline__/`,
  `${BASE_PATH}__shared__/`,
  `${BASE_PATH}mirror-map.json`,
];

let mapPromise = null;
function getMap() {
  if (!mapPromise) {
    mapPromise = fetch(MAP_URL, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`mirror map ${r.status}`);
        return r.json();
      })
      .then((map) => ({ map, reverse: makeReverseIndex(map) }));
  }
  return mapPromise;
}

// Assets mirrored with a cache-busting query get a .__q<hash> suffix in their
// local filename. Strip it so a relative request such as
// /assets/cars.png?v=123 can still find /assets/cars.__qabc12345.png.
function normalizeLocalPath(value) {
  return String(value).replace(/\.__q[0-9a-f]{8}(?=\.[^./]+$)/i, "");
}

function makeReverseIndex(map) {
  const reverse = new Map();
  for (const value of Object.values(map)) {
    if (typeof value !== "string" || !value.startsWith("/")) continue;
    const norm = normalizeLocalPath(value);
    if (!reverse.has(norm)) reverse.set(norm, value);
    if (!reverse.has(value)) reverse.set(value, value);
  }
  return reverse;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    try { await getMap(); } catch (err) { console.error("offline map:", err); }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function lookup(entry, rawUrl) {
  const { map, reverse } = entry;
  const noHash = rawUrl.split("#")[0];
  if (map[noHash]) return map[noHash];
  try {
    const u = new URL(noHash);
    if (map[u.origin + u.pathname]) return map[u.origin + u.pathname];
    if (map[u.pathname]) return map[u.pathname];
    const norm = normalizeLocalPath(u.pathname);
    if (reverse.has(norm)) return reverse.get(norm);
    if (reverse.has(u.pathname)) return reverse.get(u.pathname);
  } catch {}
  return null;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" && req.method !== "HEAD") return;

  const url = req.url.split("#")[0];
  const pathname = (() => { try { return new URL(url).pathname; } catch { return ""; } })();
  if (PASSTHROUGH.some((p) => pathname === p || pathname.startsWith(p))) return;

  event.respondWith((async () => {
    let entry;
    try { entry = await getMap(); } catch { entry = { map: {}, reverse: new Map() }; }

    const local = lookup(entry, url);
    if (local) {
      const headers = new Headers();
      const range = req.headers.get("range");
      if (range) headers.set("Range", range);
      const res = await fetch(local, { headers, cache: "no-store" });
      const out = new Headers(res.headers);
      out.set("Access-Control-Allow-Origin", "*");
      out.set("Cross-Origin-Resource-Policy", "cross-origin");
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
    }

    if (url.startsWith(self.location.origin + "/")) {
      // Same-origin path that is not an original URL: let the local server serve it.
      return fetch(req);
    }

    // External URL that was never mirrored. Fail closed so the game never
    // silently reaches the internet.
    console.warn("offline: blocked unmirrored external request", url);
    return new Response(`Offline: resource not mirrored\n${url}`, {
      status: 404,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  })());
});
