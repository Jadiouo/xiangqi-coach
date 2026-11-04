type StorageLike = Pick<Storage, "getItem" | "setItem">;

export const DEFAULT_DIFFICULTY = 5;
const STORAGE_KEY = "xq.difficulty.v1";

/** The level the user chose last time; anything unreadable or out of 1..10 falls back to the default. */
export function loadDifficulty(storage: StorageLike | null): number {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw || !/^\d{1,2}$/.test(raw)) return DEFAULT_DIFFICULTY;
    const level = Number(raw);
    return level >= 1 && level <= 10 ? level : DEFAULT_DIFFICULTY;
  } catch {
    return DEFAULT_DIFFICULTY;
  }
}

export function saveDifficulty(storage: StorageLike | null, level: number): void {
  try { storage?.setItem(STORAGE_KEY, String(level)); } catch { /* storage is a convenience only */ }
}

/** window.localStorage, or null when the browser refuses access (private window, blocked site data). */
export function browserStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try { return window.localStorage; } catch { return null; }
}
