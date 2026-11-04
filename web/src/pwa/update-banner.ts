import { zhTW } from "../locale/zh-TW";

/** The slice of Document the banner uses, so tests can pass a fake. */
export interface BannerDocument {
  createElement(tag: "div" | "span" | "button"): HTMLElement;
  getElementById(id: string): HTMLElement | null;
  body: { prepend(el: HTMLElement): void };
}

export const APPLY_TIMEOUT_MS = 10_000;
const BANNER_ID = "update-banner";

function bannerRoot(doc: BannerDocument): HTMLElement {
  let banner = doc.getElementById(BANNER_ID);
  if (!banner) {
    banner = doc.createElement("div");
    banner.id = BANNER_ID;
    banner.setAttribute("role", "status");
    doc.body.prepend(banner);
  }
  return banner;
}

function span(doc: BannerDocument, text: string): HTMLElement {
  const el = doc.createElement("span");
  el.textContent = text;
  return el;
}

function button(doc: BannerDocument, id: string, text: string): HTMLButtonElement {
  const el = doc.createElement("button") as HTMLButtonElement;
  el.type = "button";
  el.id = id;
  el.textContent = text;
  return el;
}

/** "New version" bar. `apply` returns false when nothing was waiting; the button is then pressable again. */
export function showUpdateBanner(doc: BannerDocument, apply: () => boolean): void {
  const banner = bannerRoot(doc);
  const action = button(doc, "update-banner-button", zhTW.updateBanner.button);
  action.addEventListener("click", () => {
    action.disabled = true;
    if (!apply()) {
      action.disabled = false;
      return;
    }
    // If the page was never taken over (e.g. the worker was superseded), let the user try again.
    setTimeout(() => { action.disabled = false; }, APPLY_TIMEOUT_MS);
  });
  banner.replaceChildren(span(doc, zhTW.updateBanner.message), span(doc, zhTW.updateBanner.unsavedWarning), action);
}

/** Shown in a tab that was taken over because another tab pressed update; it never reloads by itself. */
export function showUpdatedNotice(doc: BannerDocument, reload: () => void): void {
  const banner = bannerRoot(doc);
  const action = button(doc, "update-banner-button", zhTW.updateBanner.refreshButton);
  action.addEventListener("click", reload);
  banner.replaceChildren(span(doc, zhTW.updateBanner.updated), action);
}
