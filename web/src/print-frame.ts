const FRAME_ID = "print-frame";

export interface PrintEnvironment {
  doc?: Document;
  /** window.open; used as the way out when the hidden frame cannot print. */
  open?: () => Window | null;
  /** Called when the report was put in a new tab instead of the print dialog. */
  onFallback?: () => void;
  /** Called when nothing could be shown at all (frame failed and the new tab was blocked). */
  onFailure?: () => void;
}

/**
 * Prints an HTML document through a hidden iframe, so the app's own page is not printed.
 * The frame stays zero-sized but rendered (a display:none frame prints blank in Safari) and is removed after printing
 * or when the next print starts, whichever comes first. If the frame cannot be made or print() throws (some mobile
 * browsers), the same HTML opens in a new tab and `onFallback` lets the page tell the user to save it from there.
 */
export function printHtmlDocument(html: string, env: PrintEnvironment = {}): void {
  const doc = env.doc ?? document;
  const fallback = (): void => {
    const tab = (env.open ?? (() => window.open("", "_blank")))();
    if (!tab) { env.onFailure?.(); return; }
    tab.document.write(html);
    tab.document.close();
    env.onFallback?.();
  };
  try {
    doc.getElementById(FRAME_ID)?.remove();
    const frame = doc.createElement("iframe");
    frame.id = FRAME_ID;
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    frame.addEventListener("load", () => {
      const view = frame.contentWindow;
      if (!view) { frame.remove(); fallback(); return; }
      try {
        view.addEventListener("afterprint", () => frame.remove());
        view.focus();
        view.print();
      } catch {
        frame.remove();
        fallback();
      }
    }, { once: true });
    frame.srcdoc = html;
    doc.body.append(frame);
  } catch {
    fallback();
  }
}
