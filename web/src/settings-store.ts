type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem">;

/** Nodes per position for a review: the quick, standard and deeper choices of the settings page. */
export const REVIEW_BUDGETS = [100_000, 1_000_000, 5_000_000] as const;

export interface Settings {
  reviewBudget: number;
}

export const DEFAULT_SETTINGS: Settings = { reviewBudget: REVIEW_BUDGETS[0] };

const STORAGE_KEY = "xq.settings.v1";
const VERSION = 1;

/** Stored settings of this version; a missing or odd field takes its default, another version is dropped whole. */
export function loadSettings(storage: ReadStorage | null): Settings {
  const settings = { ...DEFAULT_SETTINGS };
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return settings;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== VERSION) return settings;
    const budget = (parsed as { reviewBudget?: unknown }).reviewBudget;
    if ((REVIEW_BUDGETS as readonly unknown[]).includes(budget)) settings.reviewBudget = budget as number;
  } catch { /* unreadable storage or text: defaults */ }
  return settings;
}

/** Keeps the settings of this session in memory, so a refused write only costs the next visit. */
export function createSettingsStore(storage: (ReadStorage & WriteStorage) | null) {
  let current = loadSettings(storage);
  return {
    get: (): Settings => ({ ...current }),
    set(patch: Partial<Settings>): void {
      current = { ...current, ...patch };
      try { storage?.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, ...current })); } catch { /* storage is a convenience only */ }
    },
  };
}
