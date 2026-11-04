import { describe, expect, it, vi } from "vitest";
import { registerServiceWorker } from "./register";

type Listener = () => void;

class FakeTarget {
  listeners: Record<string, Listener[]> = {};
  addEventListener(type: string, fn: Listener) { (this.listeners[type] ??= []).push(fn); }
  emit(type: string) { for (const fn of this.listeners[type] ?? []) fn(); }
}

class FakeWorker extends FakeTarget {
  state = "installing";
  postMessage = vi.fn();
}

class FakeRegistration extends FakeTarget {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  update = vi.fn().mockResolvedValue(undefined);
}

class FakeContainer extends FakeTarget {
  controller: object | null = {};
  constructor(public registration: FakeRegistration) { super(); }
  register = vi.fn(async () => this.registration);
}

class FakeDocument extends FakeTarget {
  visibilityState = "visible";
}

function setup(opts: { controller?: boolean; waiting?: boolean } = {}) {
  const registration = new FakeRegistration();
  const container = new FakeContainer(registration);
  if (opts.controller === false) container.controller = null;
  if (opts.waiting) registration.waiting = new FakeWorker();
  const document = new FakeDocument();
  const reload = vi.fn();
  const onUpdateReady = vi.fn();
  const onUpdatedElsewhere = vi.fn();
  let clock = 0;
  const start = () =>
    registerServiceWorker({
      navigator: { serviceWorker: container },
      base: "/",
      production: true,
      onUpdateReady,
      onUpdatedElsewhere,
      reload,
      document,
      now: () => clock,
      updateCheckIntervalMs: 60_000,
    });
  return { registration, container, document, reload, onUpdateReady, onUpdatedElsewhere, start, advance: (ms: number) => (clock += ms) };
}

describe("update prompt", () => {
  it("offers the update when a worker is already waiting at load", async () => {
    const t = setup({ waiting: true });
    await t.start();
    expect(t.onUpdateReady).toHaveBeenCalledTimes(1);
  });

  it("does not offer anything when nothing is waiting", async () => {
    const t = setup();
    await t.start();
    expect(t.onUpdateReady).not.toHaveBeenCalled();
  });

  it("offers the update when a found worker reaches installed and a controller exists", async () => {
    const t = setup();
    await t.start();
    const worker = new FakeWorker();
    t.registration.installing = worker;
    t.registration.waiting = worker;
    t.registration.emit("updatefound");
    expect(t.onUpdateReady).not.toHaveBeenCalled();
    worker.state = "installed";
    worker.emit("statechange");
    expect(t.onUpdateReady).toHaveBeenCalledTimes(1);
  });

  it("does not offer on the very first install (no controller yet)", async () => {
    const t = setup({ controller: false });
    await t.start();
    const worker = new FakeWorker();
    t.registration.installing = worker;
    t.registration.emit("updatefound");
    worker.state = "installed";
    worker.emit("statechange");
    expect(t.onUpdateReady).not.toHaveBeenCalled();
  });

  it("applying posts skip-waiting to the waiting worker", async () => {
    const t = setup({ waiting: true });
    await t.start();
    const apply = t.onUpdateReady.mock.calls[0][0] as () => void;
    apply();
    expect(t.registration.waiting!.postMessage).toHaveBeenCalledWith({ type: "skip-waiting" });
  });

  it("does not reload until the user applied the update", async () => {
    const t = setup({ waiting: true });
    await t.start();
    t.container.emit("controllerchange");
    expect(t.reload).not.toHaveBeenCalled();
  });

  it("reloads exactly once after applying, however many controllerchange events fire", async () => {
    const t = setup({ waiting: true });
    await t.start();
    (t.onUpdateReady.mock.calls[0][0] as () => boolean)();
    t.container.emit("controllerchange");
    t.container.emit("controllerchange");
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it("checks for updates when the tab becomes visible, at most once per interval", async () => {
    const t = setup();
    await t.start();
    t.advance(60_000);
    t.document.emit("visibilitychange");
    expect(t.registration.update).toHaveBeenCalledTimes(1);
    t.advance(1_000);
    t.document.emit("visibilitychange");
    expect(t.registration.update).toHaveBeenCalledTimes(1);
    t.advance(60_000);
    t.document.emit("visibilitychange");
    expect(t.registration.update).toHaveBeenCalledTimes(2);
  });

  it("does not check while the tab is hidden, and swallows update() failures", async () => {
    const t = setup();
    await t.start();
    t.advance(120_000);
    t.document.visibilityState = "hidden";
    t.document.emit("visibilitychange");
    expect(t.registration.update).not.toHaveBeenCalled();
    t.document.visibilityState = "visible";
    t.registration.update.mockRejectedValue(new Error("offline"));
    expect(() => t.document.emit("visibilitychange")).not.toThrow();
  });
});

describe("apply looks up the waiting worker at click time", () => {
  it("posts to the newest waiting worker after the offer was made twice", async () => {
    const t = setup({ waiting: true });
    await t.start();
    const v2 = t.registration.waiting!;
    const firstApply = t.onUpdateReady.mock.calls[0][0] as () => boolean;
    const v3 = new FakeWorker();
    t.registration.waiting = v3;
    t.registration.installing = v3;
    t.registration.emit("updatefound");
    v3.state = "installed";
    v3.emit("statechange");
    expect(t.onUpdateReady).toHaveBeenCalledTimes(2);
    const secondApply = t.onUpdateReady.mock.calls[1][0] as () => boolean;
    expect(secondApply()).toBe(true);
    expect(v3.postMessage).toHaveBeenCalledWith({ type: "skip-waiting" });
    expect(v2.postMessage).not.toHaveBeenCalled();
    // even the stale apply from the first offer reaches the newest worker
    v3.postMessage.mockClear();
    expect(firstApply()).toBe(true);
    expect(v3.postMessage).toHaveBeenCalledTimes(1);
  });

  it("with nothing waiting it checks for an update and reports false", async () => {
    const t = setup({ waiting: true });
    await t.start();
    const old = t.registration.waiting!;
    t.registration.waiting = null;
    const apply = t.onUpdateReady.mock.calls[0][0] as () => boolean;
    expect(apply()).toBe(false);
    expect(old.postMessage).not.toHaveBeenCalled();
    expect(t.registration.update).toHaveBeenCalledTimes(1);
  });
});

describe("a tab that did not ask for the update", () => {
  it("shows the updated notice instead of reloading when the controller changes", async () => {
    const t = setup();
    await t.start();
    t.container.emit("controllerchange");
    expect(t.onUpdatedElsewhere).toHaveBeenCalledTimes(1);
    expect(t.reload).not.toHaveBeenCalled();
  });

  it("stays quiet on the first install (no controller before the change)", async () => {
    const t = setup({ controller: false });
    await t.start();
    t.container.controller = {};
    t.container.emit("controllerchange");
    expect(t.onUpdatedElsewhere).not.toHaveBeenCalled();
    expect(t.reload).not.toHaveBeenCalled();
  });

  it("the tab that applied reloads and does not show the notice", async () => {
    const t = setup({ waiting: true });
    await t.start();
    (t.onUpdateReady.mock.calls[0][0] as () => boolean)();
    t.container.emit("controllerchange");
    expect(t.reload).toHaveBeenCalledTimes(1);
    expect(t.onUpdatedElsewhere).not.toHaveBeenCalled();
  });
});
