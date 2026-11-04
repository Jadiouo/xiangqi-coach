import { describe, expect, it } from "vitest";
import { printHtmlDocument } from "./print-frame";

type Listener = () => void;
function fakeDocument(printThrows: boolean) {
  const frame: Record<string, any> = { style: {}, listeners: {} as Record<string, Listener>, removed: false };
  frame.setAttribute = () => {};
  frame.addEventListener = (name: string, fn: Listener) => { frame.listeners[name] = fn; };
  frame.remove = () => { frame.removed = true; };
  frame.contentWindow = { addEventListener: () => {}, focus: () => {}, print: () => { if (printThrows) throw new Error("print blocked"); } };
  const doc = { getElementById: () => null, createElement: () => frame, body: { append: () => {} } } as unknown as Document;
  return { doc, frame };
}

describe("printHtmlDocument", () => {
  it("prints through the hidden frame and does not open a tab when print works", () => {
    const { doc, frame } = fakeDocument(false);
    const opened: string[] = [];
    let fellBack = false;
    printHtmlDocument("<p>x</p>", { doc, open: () => { opened.push("tab"); return null; }, onFallback: () => { fellBack = true; } });
    frame.listeners.load!();
    expect(opened).toEqual([]);
    expect(fellBack).toBe(false);
  });

  it("falls back to a new tab holding the same html, and says so, when print() throws", () => {
    const { doc, frame } = fakeDocument(true);
    const written: string[] = [];
    let fellBack = false;
    const tab = { document: { write: (text: string) => { written.push(text); }, close: () => {} } } as unknown as Window;
    printHtmlDocument("<p>x</p>", { doc, open: () => tab, onFallback: () => { fellBack = true; } });
    frame.listeners.load!();
    expect(written).toEqual(["<p>x</p>"]);
    expect(fellBack).toBe(true);
    expect(frame.removed).toBe(true);
  });

  it("falls back at once when the frame cannot be created", () => {
    const written: string[] = [];
    const tab = { document: { write: (text: string) => { written.push(text); }, close: () => {} } } as unknown as Window;
    const doc = { getElementById: () => null, createElement: () => { throw new Error("no frame"); }, body: {} } as unknown as Document;
    let fellBack = false;
    printHtmlDocument("<p>y</p>", { doc, open: () => tab, onFallback: () => { fellBack = true; } });
    expect(written).toEqual(["<p>y</p>"]);
    expect(fellBack).toBe(true);
  });

  it("reports a failure (not silence) when print() throws and the new tab is blocked", () => {
    const { doc, frame } = fakeDocument(true);
    let fellBack = false;
    let failed = false;
    printHtmlDocument("<p>x</p>", { doc, open: () => null, onFallback: () => { fellBack = true; }, onFailure: () => { failed = true; } });
    frame.listeners.load!();
    expect(fellBack).toBe(false);
    expect(failed).toBe(true);
  });

  it("reports a failure when the frame cannot be made and the new tab is blocked", () => {
    const doc = { getElementById: () => null, createElement: () => { throw new Error("no frame"); }, body: {} } as unknown as Document;
    let failed = false;
    printHtmlDocument("<p>y</p>", { doc, open: () => null, onFailure: () => { failed = true; } });
    expect(failed).toBe(true);
  });
});
