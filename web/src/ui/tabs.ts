export const ROUTES = ["play", "review", "library", "settings"] as const;
export type Route = (typeof ROUTES)[number];
export const TAB_ROUTES = ["play", "review", "library"] as const;

const DEFAULT_ROUTE: Route = "play";

/**
 * Accepts a location.hash ("#/review"), a short form ("#review"), or a whole URL/search+hash
 * ("?review-workers=2#/library", "https://host/xiangqi-coach/#/review"). Only the part after the first "#"
 * decides the route, so the query string (before the "#") and the sub path never matter.
 */
export function parseRoute(input: string): Route {
  const at = input.indexOf("#");
  if (at < 0) return DEFAULT_ROUTE;
  let rest = input.slice(at + 1);
  if (rest.startsWith("/")) rest = rest.slice(1);
  const name = rest.split(/[/?#]/, 1)[0];
  return (ROUTES as readonly string[]).includes(name) ? (name as Route) : DEFAULT_ROUTE;
}

export function buildHash(route: Route): string {
  return `#/${route}`;
}

/** Wires the shell: buttons only change the hash; the hash drives aria-pressed/aria-current/data-route. */
export function bindShell(root: HTMLElement, win: Window = window): void {
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-route-target]"));
  const apply = (): void => {
    const route = parseRoute(win.location.hash);
    root.dataset.route = route;
    for (const button of buttons) {
      const active = button.dataset.routeTarget === route;
      button.setAttribute("aria-pressed", String(active));
      if (active && route !== "settings") button.setAttribute("aria-current", "page");
      else if (active) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
  };
  for (const button of buttons) {
    button.addEventListener("click", () => {
      const target = button.dataset.routeTarget as Route;
      const hash = buildHash(target);
      if (win.location.hash !== hash) win.location.hash = hash;
      apply();
      win.scrollTo?.(0, 0);
    });
  }
  win.addEventListener("hashchange", apply);
  apply();
}
