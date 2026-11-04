import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderServiceWorker } from "./sw-render";

const here = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(join(here, "service-worker.js"), "utf8");
const ORIGIN = "http://app.test";
const BASE = "/xiangqi-coach/";
const URLS = [BASE, `${BASE}index.html`, `${BASE}assets/a.js`, `${BASE}wasm/xq_wasm_bg.wasm`];

class FakeCache {
  store = new Map<string, Response>();
  async addAll(reqs: Array<string | Request>) {
    for (const r of reqs) this.store.set(typeof r === "string" ? new URL(r, ORIGIN).href : r.url, new Response("cached:" + (typeof r === "string" ? r : r.url)));
  }
  async match(r: string | Request) {
    return this.store.get(typeof r === "string" ? r : r.url)?.clone();
  }
}

function setup(version: string, existing: Record<string, FakeCache> = {}, online = true) {
  const caches = {
    store: existing,
    async open(name: string) { return (this.store[name] ??= new FakeCache()); },
    async keys() { return Object.keys(this.store); },
    async delete(name: string) { return delete this.store[name]; },
    async match(r: string | Request) {
      for (const c of Object.values(this.store)) { const hit = await c.match(r); if (hit) return hit; }
      return undefined;
    },
  };
  const handlers: Record<string, (e: any) => void> = {};
  const network: string[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (t: string, h: (e: any) => void) => { handlers[t] = h; },
    skipWaiting: () => { throw new Error("must not skipWaiting"); },
    clients: { claim: async () => {} },
  };
  const fetchFn = async (r: string | Request) => {
    network.push(typeof r === "string" ? r : r.url);
    if (!online) throw new TypeError("offline");
    return new Response("network");
  };
  const code = renderServiceWorker(template, { version, urls: URLS, base: BASE });
  new Function("self", "caches", "fetch", code)(self, caches, fetchFn);
  const run = async (type: string, event: Record<string, unknown> = {}) => {
    const waits: Promise<unknown>[] = [];
    let responded: Promise<Response> | undefined;
    handlers[type]({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p), respondWith: (p: Promise<Response>) => (responded = p) });
    await Promise.all(waits);
    return responded;
  };
  const req = (path: string, extra: Record<string, unknown> = {}) => ({ url: ORIGIN + path, method: "GET", mode: "same-origin", ...extra });
  return { caches, run, req, network };
}

describe("service worker rendering", () => {
  it("fills every placeholder", () => {
    const code = renderServiceWorker(template, { version: "abc123def456", urls: URLS, base: BASE });
    expect(code).not.toMatch(/__SW_[A-Z]+__/);
    expect(code).toContain("abc123def456");
    for (const u of URLS) expect(code).toContain(u);
  });
});

describe("service worker behaviour", () => {
  it("install precaches every listed url in a cache named for the version", async () => {
    const { caches, run } = setup("v1");
    await run("install");
    const names = await caches.keys();
    expect(names).toEqual(["xiangqi-coach-precache-v1"]);
    expect([...caches.store[names[0]].store.keys()].sort()).toEqual(URLS.map((u) => ORIGIN + u).sort());
  });

  it("activate removes caches older than the previous version and leaves unrelated caches alone", async () => {
    const { caches, run } = setup("v3", {
      "xiangqi-coach-precache-v1": new FakeCache(),
      "xiangqi-coach-precache-v2": new FakeCache(),
      "xiangqi-coach-precache-v3": new FakeCache(),
      "someone-elses-cache": new FakeCache(),
    });
    await run("activate");
    expect((await caches.keys()).sort()).toEqual(["someone-elses-cache", "xiangqi-coach-precache-v2", "xiangqi-coach-precache-v3"]);
  });

  it("fetch falls back to the previous version's cache before the network", async () => {
    const old = new FakeCache();
    await old.addAll([ORIGIN + BASE + "assets/old.js"]);
    const { run, req, network } = setup("v3", {
      "xiangqi-coach-precache-v2": old,
      "xiangqi-coach-precache-v3": new FakeCache(),
    }, false);
    await run("activate");
    const res = await (await run("fetch", { request: req(`${BASE}assets/old.js`) }))!;
    expect(await res.text()).toContain("cached:");
    expect(network).toEqual([]);
  });

  it("fetch prefers the current cache over the previous one", async () => {
    const old = new FakeCache();
    await old.addAll([ORIGIN + BASE + "x.js"]);
    const cur = new FakeCache();
    cur.store.set(ORIGIN + BASE + "x.js", new Response("current"));
    const { run, req } = setup("v3", { "xiangqi-coach-precache-v2": old, "xiangqi-coach-precache-v3": cur });
    await run("activate");
    const res = await (await run("fetch", { request: req(`${BASE}x.js`) }))!;
    expect(await res.text()).toBe("current");
  });

  it("serves a precached asset from cache without touching the network, even with a query string", async () => {
    const { run, req, network } = setup("v1", {}, false);
    await run("install");
    const res = await (await run("fetch", { request: req(`${BASE}assets/a.js?x=1`) }))!;
    expect(await res.text()).toContain("cached:");
    expect(network).toEqual([]);
  });

  it("answers any navigation inside the scope with the cached page when offline", async () => {
    const { run, req } = setup("v1", {}, false);
    await run("install");
    const res = await (await run("fetch", { request: req(`${BASE}some/deep/link`, { mode: "navigate" }) }))!;
    expect(await res.text()).toBe(`cached:${ORIGIN}${BASE}`);
  });

  it("falls through to the network for unknown same-origin files", async () => {
    const { run, req, network } = setup("v1");
    await run("install");
    const res = await (await run("fetch", { request: req(`${BASE}other.json`) }))!;
    expect(await res.text()).toBe("network");
    expect(network).toEqual([ORIGIN + `${BASE}other.json`]);
  });

  it("ignores non-GET and cross-origin requests", async () => {
    const { run, req } = setup("v1");
    await run("install");
    expect(await run("fetch", { request: req(`${BASE}assets/a.js`, { method: "POST" }) })).toBeUndefined();
    expect(await run("fetch", { request: { url: "https://elsewhere.test/x.js", method: "GET", mode: "cors" } })).toBeUndefined();
  });
});
