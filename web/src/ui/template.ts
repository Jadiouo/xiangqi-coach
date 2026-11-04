import { zhTW } from "../locale/zh-TW";
import { TAB_ROUTES } from "./tabs";

const TAB_LABELS = {
  play: zhTW.shell.tabPlay,
  review: zhTW.shell.tabReview,
  library: zhTW.shell.tabLibrary,
} as const;

export function shellHeaderHtml(): string {
  const tabs = TAB_ROUTES.map(
    (route) => `<button type="button" class="tab-button" data-route-target="${route}" aria-pressed="false">${TAB_LABELS[route]}</button>`,
  ).join("");
  return `<header class="topbar">
      <h1>${zhTW.appTitle}</h1>
      <nav class="tabs" aria-label="${zhTW.shell.navLabel}">${tabs}</nav>
      <button type="button" class="gear-button" data-route-target="settings" aria-label="${zhTW.shell.settings}" aria-pressed="false" title="${zhTW.shell.settings}"><span aria-hidden="true">&#9881;</span></button>
    </header>`;
}
