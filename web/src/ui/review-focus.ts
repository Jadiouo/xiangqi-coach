import { zhTW } from "../locale/zh-TW";
import type { ArrowEnds, ArrowPlan, FocusNav } from "../review-presentation";

const SVG = "http://www.w3.org/2000/svg";

export interface FocusCardModel {
  position: string;
  classification: string;
  playedMove: string;
  /** Better move in Chinese notation; null when the review has no comparison for this move. */
  bestMove: string | null;
  reason: string | null;
  playedFollow: string | null;
  bestFollow: string | null;
}

export interface FocusModel {
  summary: string;
  /** Short line under the summary when there are no chips to show yet. */
  note: string | null;
  chips: Array<{ index: number; label: string; ariaLabel: string; selected: boolean; severity: string }>;
  hint: string | null;
  card: FocusCardModel | null;
  nav: FocusNav;
  nextTime: string | null;
}

export interface FocusHandlers {
  select(index: number): void;
}

function text<K extends keyof HTMLElementTagNameMap>(tag: K, content: string, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = content;
  if (className) element.className = className;
  return element;
}

/** Rebuilds the key-move summary, chips and card. Called only while the review page is the visible one. */
export function renderReviewFocus(root: HTMLElement, model: FocusModel, handlers: FocusHandlers, disabled: boolean): void {
  const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
  const focusedChip = active?.getAttribute("data-review-chip") ?? null;
  const focusedId = focusedChip === null ? active?.id || null : null;
  root.replaceChildren();
  root.append(text("h2", model.summary, "focus-summary"));
  if (model.note) root.append(text("p", model.note, "focus-note"));

  if (model.chips.length) {
    const chips = document.createElement("div");
    chips.className = "focus-chips";
    for (const chip of model.chips) {
      const button = text("button", chip.label, `focus-chip focus-chip-${chip.severity}`);
      button.type = "button";
      button.dataset.reviewChip = String(chip.index);
      button.setAttribute("aria-label", chip.ariaLabel);
      button.setAttribute("aria-pressed", String(chip.selected));
      if (chip.selected) button.setAttribute("aria-current", "true");
      button.disabled = disabled;
      button.addEventListener("click", () => handlers.select(chip.index));
      chips.append(button);
    }
    root.append(chips);
  }
  if (model.hint) root.append(text("p", model.hint, "focus-note"));

  const card = model.card;
  if (card) {
    const section = document.createElement("div");
    section.className = "focus-card";
    section.dataset.focusCard = "";
    section.tabIndex = -1;
    const head = document.createElement("div");
    head.className = "focus-card-head";
    // a new key move replaces the head text; screen readers announce it
    head.setAttribute("aria-live", "polite");
    head.append(text("span", card.classification, "focus-tag"), text("p", card.position, "focus-position"));
    section.append(head);

    const moves = document.createElement("div");
    moves.className = "focus-moves";
    const played = document.createElement("div");
    played.className = "focus-move focus-move-played";
    played.append(text("span", zhTW.review.focus.played, "focus-move-label"), text("strong", card.playedMove));
    const best = document.createElement("div");
    best.className = "focus-move focus-move-best";
    best.append(
      text("span", zhTW.review.focus.best, "focus-move-label"),
      text("strong", card.bestMove ?? zhTW.review.focus.bestOnBoard),
    );
    moves.append(played, best);
    section.append(moves);

    if (card.reason) section.append(text("p", card.reason, "focus-reason"));
    if (card.playedFollow !== null) {
      section.append(text("h3", zhTW.review.focus.playedFollow), text("p", card.playedFollow, "focus-follow"));
    }
    if (card.bestFollow !== null) {
      section.append(
        text("h3", card.bestMove ? zhTW.review.focus.bestFollow(card.bestMove) : zhTW.review.focus.bestFollowNoMove),
        text("p", card.bestFollow, "focus-follow"),
      );
    }
    root.append(section);
  }

  if (model.chips.length) {
    const nav = document.createElement("div");
    nav.className = "actions focus-nav";
    const prev = text("button", zhTW.review.focus.prev, "secondary");
    prev.type = "button";
    prev.id = "review-focus-prev";
    prev.disabled = disabled || model.nav.prevDisabled;
    prev.addEventListener("click", () => { if (model.nav.prev !== null) handlers.select(model.nav.prev); });
    const next = text("button", zhTW.review.focus.next);
    next.type = "button";
    next.id = "review-focus-next";
    next.disabled = disabled || model.nav.nextDisabled;
    next.addEventListener("click", () => { if (model.nav.next !== null) handlers.select(model.nav.next); });
    nav.append(prev, next);
    root.append(nav);
  }
  if (model.nextTime) {
    const tip = document.createElement("div");
    tip.className = "focus-next-time";
    tip.append(text("strong", zhTW.review.focus.nextTime), text("p", model.nextTime));
    root.append(tip);
  }
  if (focusedChip !== null || focusedId !== null) {
    // never build a selector from the value: a chip index such as "3" is not a valid "#3" id selector
    const again = focusedChip !== null
      ? Array.from(root.querySelectorAll<HTMLElement>("[data-review-chip]")).find((el) => el.dataset.reviewChip === focusedChip) ?? null
      : root.querySelector<HTMLElement>(`[id="${focusedId}"]`);
    // keep the keyboard place when a chip or the step buttons were pressed
    if (again && !again.hasAttribute("disabled")) {
      again.focus({ preventScroll: true });
    } else {
      // the pressed button just became disabled (end of the list): move to the other step button, else the card
      const other = focusedId === "review-focus-next" ? "review-focus-prev" : focusedId === "review-focus-prev" ? "review-focus-next" : null;
      const fallback = (other ? root.querySelector<HTMLElement>(`#${other}:not([disabled])`) : null)
        ?? root.querySelector<HTMLElement>("[data-focus-card]");
      fallback?.focus({ preventScroll: true });
    }
  }
}

type Centre = (square: string) => [number, number];

function arrow(kind: "played" | "best", ends: ArrowEnds, centre: Centre): SVGGElement {
  const [x1, y1] = centre(ends.from);
  const [x2, y2] = centre(ends.to);
  const length = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / length;
  const uy = (y2 - y1) / length;
  // start at the edge of the piece and stop short of the target so the head sits beside the piece
  const sx = x1 + ux * 18;
  const sy = y1 + uy * 18;
  const ex = x2 - ux * 20;
  const ey = y2 - uy * 20;
  const group = document.createElementNS(SVG, "g");
  group.setAttribute("class", `review-arrow review-arrow-${kind}`);
  group.setAttribute("data-arrow", kind);
  group.setAttribute("data-arrow-from", ends.from);
  group.setAttribute("data-arrow-to", ends.to);
  const line = document.createElementNS(SVG, "line");
  line.setAttribute("x1", sx.toFixed(1));
  line.setAttribute("y1", sy.toFixed(1));
  line.setAttribute("x2", ex.toFixed(1));
  line.setAttribute("y2", ey.toFixed(1));
  const head = document.createElementNS(SVG, "polygon");
  const px = -uy;
  const py = ux;
  const tipX = ex + ux * 12;
  const tipY = ey + uy * 12;
  head.setAttribute("points", [
    `${tipX.toFixed(1)},${tipY.toFixed(1)}`,
    `${(ex + px * 8).toFixed(1)},${(ey + py * 8).toFixed(1)}`,
    `${(ex - px * 8).toFixed(1)},${(ey - py * 8).toFixed(1)}`,
  ].join(" "));
  group.append(line, head);
  return group;
}

/** Draws the arrows and danger rings on top of the board; the layer ignores the pointer. */
export function drawReviewOverlay(svg: SVGSVGElement, plan: ArrowPlan, centre: Centre): void {
  svg.querySelector(".review-overlay")?.remove();
  if (!plan.played && !plan.best && plan.danger.length === 0) return;
  const layer = document.createElementNS(SVG, "g");
  layer.setAttribute("class", "review-overlay");
  layer.setAttribute("pointer-events", "none");
  for (const square of plan.danger) {
    const [x, y] = centre(square);
    const ring = document.createElementNS(SVG, "circle");
    ring.setAttribute("cx", String(x));
    ring.setAttribute("cy", String(y));
    ring.setAttribute("r", "26");
    ring.setAttribute("class", "review-danger");
    ring.setAttribute("data-danger", square);
    layer.append(ring);
  }
  if (plan.best) layer.append(arrow("best", plan.best, centre));
  if (plan.played) layer.append(arrow("played", plan.played, centre));
  svg.append(layer);
}
