import { describe, expect, it, vi } from "vitest";
import { registerServiceWorker } from "./register";

describe("registerServiceWorker", () => {
  it("registers sw.js under the base with the base as scope in production", async () => {
    const register = vi.fn().mockResolvedValue({});
    const ok = await registerServiceWorker({ navigator: { serviceWorker: { register } }, base: "/xiangqi-coach/", production: true });
    expect(ok).toBe(true);
    expect(register).toHaveBeenCalledWith("/xiangqi-coach/sw.js", { scope: "/xiangqi-coach/" });
  });

  it("does nothing in dev", async () => {
    const register = vi.fn();
    expect(await registerServiceWorker({ navigator: { serviceWorker: { register } }, base: "/", production: false })).toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it("does nothing where service workers are unsupported", async () => {
    expect(await registerServiceWorker({ navigator: {}, base: "/", production: true })).toBe(false);
  });

  it("a failed registration does not throw", async () => {
    const register = vi.fn().mockRejectedValue(new Error("nope"));
    expect(await registerServiceWorker({ navigator: { serviceWorker: { register } }, base: "/", production: true })).toBe(false);
  });
});
