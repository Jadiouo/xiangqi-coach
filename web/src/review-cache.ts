import type { ReviewWorkerPoint } from "./review-client";

/**
 * Bump when the shape of a stored point, or the web-side handling that changes what a point means,
 * changes in a way the wasm binary hash cannot see. Everything the wasm engine decides is covered
 * by the build hash in the version, so this is only for the TypeScript side.
 */
export const REVIEW_CACHE_SCHEMA = 2;

/**
 * The deep pass searches this many times the quick node count; part of every key. Applies to every
 * review budget. User decision 2026-10-23: 3 (was 10). Keep in step with `DEEP_NODE_MULTIPLIER` in
 * `crates/xq-wasm/src/lib.rs`.
 */
export const DEEP_NODE_MULTIPLIER = 3;

/** Node budget of the deep pass (and of "想更久") for a quick budget. */
export function deepNodeLimit(quickNodeLimit: number): number {
  return quickNodeLimit * DEEP_NODE_MULTIPLIER;
}

/** At most this many analyzed plies are kept; the least recently used go first. */
export const REVIEW_CACHE_MAX_ENTRIES = 3_000;

const DATABASE_NAME = "xiangqi-coach-review-cache";
const DATABASE_VERSION = 1;
const POINTS = "points";
const USAGE = "usage";

export interface ReviewCacheKeyParts {
  version: string;
  startFen: string;
  /** The whole game; only the moves up to and including `ply` take part in the key. */
  moves: readonly string[];
  ply: number;
  quickNodeLimit: number;
  deepMultiplier: number;
}

/** Cache version: the schema number, the build hash of the analysis code, and an optional test override. */
export function reviewCacheVersion(buildHash: string, override = ""): string {
  return `${REVIEW_CACHE_SCHEMA}.${buildHash}${override ? `+${override}` : ""}`;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Analysis of a ply depends on the repetition history, so the key covers the start position and every
 * move up to that ply, not just the position. Two games with the same opening share their keys.
 */
export async function reviewCacheKey(parts: ReviewCacheKeyParts): Promise<string> {
  const text = JSON.stringify([
    parts.version,
    parts.quickNodeLimit,
    parts.deepMultiplier,
    parts.startFen,
    parts.moves.slice(0, parts.ply + 1),
  ]);
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export interface ReviewCacheUsage {
  key: string;
  lastUsed: number;
  version: string;
}

/** Keys to delete: everything of another version, then the least recently used beyond `maxEntries`. */
export function planEviction(rows: readonly ReviewCacheUsage[], version: string, maxEntries: number): string[] {
  const doomed = rows.filter((row) => row.version !== version).map((row) => row.key);
  const kept = rows.filter((row) => row.version === version).sort((a, b) => b.lastUsed - a.lastUsed);
  return [...doomed, ...kept.slice(Math.max(0, maxEntries)).map((row) => row.key)];
}

export interface ReviewCacheStore {
  /** Points for the keys (undefined where missing); refreshes their last-used time. */
  read(keys: string[], now: number, version: string): Promise<Array<ReviewWorkerPoint | undefined>>;
  /** Stores the points, then evicts other versions and the least recently used beyond the limit. */
  write(
    entries: Array<{ key: string; point: ReviewWorkerPoint }>,
    context: { now: number; version: string; maxEntries: number },
  ): Promise<void>;
}

export function createMemoryReviewCacheStore(): ReviewCacheStore {
  const rows = new Map<string, { point: ReviewWorkerPoint; lastUsed: number; version: string }>();
  return {
    async read(keys, now) {
      return keys.map((key) => {
        const row = rows.get(key);
        if (!row) return undefined;
        row.lastUsed = now;
        return structuredClone(row.point);
      });
    },
    async write(entries, { now, version, maxEntries }) {
      for (const { key, point } of entries) rows.set(key, { point: structuredClone(point), lastUsed: now, version });
      const usage = [...rows].map(([key, row]) => ({ key, lastUsed: row.lastUsed, version: row.version }));
      for (const key of planEviction(usage, version, maxEntries)) rows.delete(key);
    },
  };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

/**
 * Points live in one object store and a small usage row (key, last used, version) in another, so
 * eviction can read and sort the usage rows without loading every stored point.
 */
export function createIndexedDbReviewCacheStore(factory: IDBFactory | undefined = globalThis.indexedDB): ReviewCacheStore {
  let opened: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (!opened) {
      opened = new Promise<IDBDatabase>((resolve, reject) => {
        if (!factory) {
          reject(new Error("IndexedDB is not available"));
          return;
        }
        const req = factory.open(DATABASE_NAME, DATABASE_VERSION);
        req.onupgradeneeded = () => {
          const database = req.result;
          if (!database.objectStoreNames.contains(POINTS)) database.createObjectStore(POINTS, { keyPath: "key" });
          if (!database.objectStoreNames.contains(USAGE)) database.createObjectStore(USAGE, { keyPath: "key" });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
        req.onblocked = () => reject(new Error("IndexedDB open blocked"));
      });
      // A failed open is retried by the next call instead of staying failed for the whole page life.
      opened.catch(() => { opened = null; });
    }
    return opened;
  };
  let sweptVersion: string | null = null;

  return {
    async read(keys, now, version) {
      const database = await open();
      const tx = database.transaction([POINTS, USAGE], "readwrite");
      const done = finished(tx);
      done.catch(() => {});
      const points = tx.objectStore(POINTS);
      const usage = tx.objectStore(USAGE);
      const found: Array<ReviewWorkerPoint | undefined> = [];
      for (const key of keys) {
        const row = (await request(points.get(key))) as { point: ReviewWorkerPoint; version: string } | undefined;
        if (row && row.version === version) {
          found.push(row.point);
          await request(usage.put({ key, lastUsed: now, version }));
        } else {
          found.push(undefined);
        }
      }
      await done;
      return found;
    },
    async write(entries, { now, version, maxEntries }) {
      const database = await open();
      const tx = database.transaction([POINTS, USAGE], "readwrite");
      const done = finished(tx);
      done.catch(() => {});
      const points = tx.objectStore(POINTS);
      const usage = tx.objectStore(USAGE);
      for (const { key, point } of entries) {
        await request(points.put({ key, point, version }));
        await request(usage.put({ key, lastUsed: now, version }));
      }
      // Reading every usage row on each write would be wasteful; look only when over the limit or on
      // the first write of this page for this version (to drop what older versions left behind).
      const total = await request(usage.count());
      if (total > maxEntries || sweptVersion !== version) {
        const rows = (await request(usage.getAll())) as ReviewCacheUsage[];
        for (const key of planEviction(rows, version, maxEntries)) {
          await request(points.delete(key));
          await request(usage.delete(key));
        }
        sweptVersion = version;
      }
      await done;
    },
  };
}

export interface ReviewCacheOptions {
  version: string;
  store: ReviewCacheStore;
  maxEntries?: number;
  now?: () => number;
}

/** What the worker pool needs from a cache. */
export interface ReviewResultCache {
  /** Finished points of this game by ply, or an empty map; never rejects. */
  lookup(startFen: string, moves: readonly string[], quickNodeLimit: number): Promise<Map<number, ReviewWorkerPoint>>;
  /** Stores finished points; unfinished ones are skipped; never rejects. */
  save(
    startFen: string,
    moves: readonly string[],
    quickNodeLimit: number,
    entries: Array<{ ply: number; point: ReviewWorkerPoint }>,
  ): Promise<void>;
}

/**
 * Every storage failure (private mode, quota, a missing crypto API) is a miss or a skipped write, so a
 * review always works without the cache.
 */
export class ReviewCache implements ReviewResultCache {
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(private readonly options: ReviewCacheOptions) {
    this.maxEntries = options.maxEntries ?? REVIEW_CACHE_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
  }

  private keyFor(startFen: string, moves: readonly string[], quickNodeLimit: number, ply: number): Promise<string> {
    return reviewCacheKey({
      version: this.options.version, startFen, moves, ply, quickNodeLimit, deepMultiplier: DEEP_NODE_MULTIPLIER,
    });
  }

  async lookup(startFen: string, moves: readonly string[], quickNodeLimit: number): Promise<Map<number, ReviewWorkerPoint>> {
    const hits = new Map<number, ReviewWorkerPoint>();
    try {
      const keys = await Promise.all(moves.map((_, ply) => this.keyFor(startFen, moves, quickNodeLimit, ply)));
      const points = await this.options.store.read(keys, this.now(), this.options.version);
      points.forEach((point, ply) => {
        if (point && point.continuationComplete === true) hits.set(ply, point);
      });
    } catch {
      return new Map();
    }
    return hits;
  }

  async save(
    startFen: string,
    moves: readonly string[],
    quickNodeLimit: number,
    entries: Array<{ ply: number; point: ReviewWorkerPoint }>,
  ): Promise<void> {
    try {
      const complete = entries.filter(({ point }) => point.continuationComplete === true);
      if (!complete.length) return;
      const keyed = await Promise.all(complete.map(async ({ ply, point }) => ({
        key: await this.keyFor(startFen, moves, quickNodeLimit, ply),
        point,
      })));
      await this.options.store.write(keyed, {
        now: this.now(), version: this.options.version, maxEntries: this.maxEntries,
      });
    } catch {
      // A cache that cannot be written is the same as no cache.
    }
  }
}

/**
 * The cache the app uses, or undefined when `?review-cache=off` (tests and measurements).
 * `?review-cache-version=X` adds X to the version, which is how a test simulates a new engine build.
 */
export function createAppReviewCache(
  search: string,
  factory: IDBFactory | undefined = globalThis.indexedDB,
): ReviewCache | undefined {
  const params = new URLSearchParams(search);
  if (params.get("review-cache") === "off") return undefined;
  return new ReviewCache({
    version: reviewCacheVersion(__REVIEW_BUILD_HASH__, params.get("review-cache-version") ?? ""),
    store: createIndexedDbReviewCacheStore(factory),
  });
}
