import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { renderServiceWorker } from "./sw-render";

const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "service-worker.js"), "utf8");

function load() {
  const handlers: Record<string, (e: any) => void> = {};
  const skipWaiting = vi.fn().mockResolvedValue(undefined);
  const self = {
    location: { origin: "http://app.test" },
    addEventListener: (t: string, h: (e: any) => void) => { handlers[t] = h; },
    skipWaiting,
    clients: { claim: async () => {} },
  };
  const code = renderServiceWorker(template, { version: "v1", urls: ["/"], base: "/" });
  new Function("self", "caches", "fetch", code)(self, { open: async () => ({ addAll: async () => {} }) }, async () => new Response("x"));
  return { handlers, skipWaiting };
}

describe("service worker message handler", () => {
  it("calls skipWaiting on {type:'skip-waiting'}", () => {
    const { handlers, skipWaiting } = load();
    handlers.message({ data: { type: "skip-waiting" }, waitUntil: () => {} });
    expect(skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("ignores other messages", () => {
    const { handlers, skipWaiting } = load();
    handlers.message({ data: { type: "other" }, waitUntil: () => {} });
    handlers.message({ data: null, waitUntil: () => {} });
    handlers.message({ data: "skip-waiting", waitUntil: () => {} });
    expect(skipWaiting).not.toHaveBeenCalled();
  });

  it("does not skip waiting on install by itself", () => {
    const { handlers, skipWaiting } = load();
    handlers.install?.({ waitUntil: () => {} });
    expect(skipWaiting).not.toHaveBeenCalled();
  });
});
