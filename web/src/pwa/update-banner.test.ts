import { afterEach, describe, expect, it, vi } from "vitest";
import { showUpdateBanner, showUpdatedNotice, type BannerDocument } from "./update-banner";
import { zhTW } from "../locale/zh-TW";

class FakeEl {
  id = "";
  disabled = false;
  type = "";
  textContent = "";
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  listeners: Record<string, Array<() => void>> = {};
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  append(...c: FakeEl[]) { this.children.push(...c); }
  replaceChildren(...c: FakeEl[]) { this.children = c; }
  addEventListener(t: string, fn: () => void) { (this.listeners[t] ??= []).push(fn); }
  click() { if (!this.disabled) for (const fn of this.listeners.click ?? []) fn(); }
  all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  texts() { return this.all().map((e) => e.textContent); }
  button() { return this.all().find((e) => e.type === "button")!; }
}

function fakeDoc() {
  const roots: FakeEl[] = [];
  const doc: BannerDocument = {
    createElement: () => new FakeEl(),
    getElementById: (id: string) => roots.find((r) => r.id === id) ?? null,
    body: { prepend: (e: FakeEl) => roots.unshift(e) },
  } as unknown as BannerDocument;
  return { doc, roots };
}

afterEach(() => vi.useRealTimers());

describe("showUpdateBanner", () => {
  it("builds one status banner with text from the locale, even when called twice", () => {
    const { doc, roots } = fakeDoc();
    showUpdateBanner(doc, () => true);
    showUpdateBanner(doc, () => true);
    expect(roots).toHaveLength(1);
    expect(roots[0].attrs.role).toBe("status");
    expect(roots[0].texts()).toContain(zhTW.updateBanner.message);
    expect(roots[0].texts()).toContain(zhTW.updateBanner.unsavedWarning);
    expect(roots[0].button().textContent).toBe(zhTW.updateBanner.button);
  });

  it("the second call keeps working with the latest apply", () => {
    const { doc, roots } = fakeDoc();
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    showUpdateBanner(doc, first);
    showUpdateBanner(doc, second);
    roots[0].button().click();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("pressing disables the button and calls apply", () => {
    const { doc, roots } = fakeDoc();
    const apply = vi.fn(() => true);
    showUpdateBanner(doc, apply);
    const button = roots[0].button();
    button.click();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
  });

  it("re-enables the button when there was no waiting worker to apply", () => {
    const { doc, roots } = fakeDoc();
    showUpdateBanner(doc, () => false);
    const button = roots[0].button();
    button.click();
    expect(button.disabled).toBe(false);
  });

  it("re-enables the button after 10 seconds without a controller change", () => {
    vi.useFakeTimers();
    const { doc, roots } = fakeDoc();
    showUpdateBanner(doc, () => true);
    const button = roots[0].button();
    button.click();
    vi.advanceTimersByTime(9_999);
    expect(button.disabled).toBe(true);
    vi.advanceTimersByTime(1);
    expect(button.disabled).toBe(false);
  });
});

describe("showUpdatedNotice", () => {
  it("shows the refresh prompt with a button that reloads", () => {
    const { doc, roots } = fakeDoc();
    const reload = vi.fn();
    showUpdatedNotice(doc, reload);
    expect(roots).toHaveLength(1);
    expect(roots[0].attrs.role).toBe("status");
    expect(roots[0].texts()).toContain(zhTW.updateBanner.updated);
    const button = roots[0].button();
    expect(button.textContent).toBe(zhTW.updateBanner.refreshButton);
    button.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("replaces an existing update banner instead of stacking", () => {
    const { doc, roots } = fakeDoc();
    showUpdateBanner(doc, () => true);
    showUpdatedNotice(doc, () => {});
    expect(roots).toHaveLength(1);
    expect(roots[0].texts()).not.toContain(zhTW.updateBanner.message);
    expect(roots[0].texts()).toContain(zhTW.updateBanner.updated);
  });
});
