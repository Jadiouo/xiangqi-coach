type StorageLike = Pick<Storage, "getItem" | "setItem">;

const STORAGE_KEY = "xq.devmode.v1";

/** Developer mode is off unless the player switched it on; unreadable storage or odd values mean off. */
export function loadDevMode(storage: StorageLike | null): boolean {
  try {
    return storage?.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function saveDevMode(storage: StorageLike | null, on: boolean): void {
  try { storage?.setItem(STORAGE_KEY, on ? "on" : "off"); } catch { /* storage is a convenience only */ }
}

/** CSS hides [data-dev-info] unless the shell carries data-dev="on". */
export function applyDevMode(root: HTMLElement, on: boolean): void {
  root.dataset.dev = on ? "on" : "off";
}
