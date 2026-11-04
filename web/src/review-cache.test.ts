import { describe, expect, it } from "vitest";
import {
  DEEP_NODE_MULTIPLIER,
  REVIEW_CACHE_SCHEMA,
  deepNodeLimit,
  createAppReviewCache,
  ReviewCache,
  createIndexedDbReviewCacheStore,
  createMemoryReviewCacheStore,
  planEviction,
  reviewCacheKey,
  reviewCacheVersion,
  type ReviewCacheStore,
} from "./review-cache";
import { createFakeIndexedDb } from "./fake-indexeddb";
import type { ReviewWorkerPoint } from "./review-client";

const START = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";
const MOVES = ["c3c4", "g6g5", "h2g2", "g9e7"];

const base = { version: "1.abc", startFen: START, moves: MOVES, ply: 2, quickNodeLimit: 100_000, deepMultiplier: 10 };

function point(marker: number, complete = true): ReviewWorkerPoint {
  const result = {
    bestMove: "h2e2", playedMove: "h2e2", playedRank: 1,
    bestScore: { centipawns: marker, mateIn: null }, playedScore: { centipawns: marker, mateIn: null },
    bestWinProbability: 0.5, playedWinProbability: 0.5, lossPercent: 0, classification: "good" as const, reason: null,
    candidates: [],
  };
  return { quick: result, final: result, deepened: true, continuationComplete: complete };
}

describe("reviewCacheKey", () => {
  it("is stable for the same inputs", async () => {
    expect(await reviewCacheKey(base)).toBe(await reviewCacheKey({ ...base }));
    expect(await reviewCacheKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any field changes", async () => {
    const reference = await reviewCacheKey(base);
    const variants = [
      { ...base, version: "1.abd" },
      { ...base, startFen: START.replace(" w ", " b ") },
      { ...base, moves: ["c3c4", "g6g5", "h2e2", "g9e7"] },
      { ...base, moves: ["a3a4", "g6g5", "h2g2", "g9e7"] },
      { ...base, ply: 3 },
      { ...base, quickNodeLimit: 100_001 },
      { ...base, deepMultiplier: 9 },
    ];
    const keys = await Promise.all(variants.map((variant) => reviewCacheKey(variant)));
    for (const key of keys) expect(key).not.toBe(reference);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("depends only on the moves up to and including the ply, so a shared opening shares keys", async () => {
    const other = { ...base, moves: ["c3c4", "g6g5", "h2g2", "b9c7", "a0a1"] };
    expect(await reviewCacheKey(other)).toBe(await reviewCacheKey(base));
    expect(await reviewCacheKey({ ...other, ply: 3 })).not.toBe(await reviewCacheKey({ ...base, ply: 3 }));
  });

  it("does not confuse a move boundary with a space", async () => {
    const a = await reviewCacheKey({ ...base, moves: ["ab", "cd"], ply: 1 });
    const b = await reviewCacheKey({ ...base, moves: ["a", "bcd"], ply: 1 });
    expect(a).not.toBe(b);
  });
});

describe("reviewCacheVersion", () => {
  it("includes the schema, the build hash and an optional override", () => {
    expect(reviewCacheVersion("aaa")).toContain(String(REVIEW_CACHE_SCHEMA));
    expect(reviewCacheVersion("aaa")).toContain("aaa");
    expect(reviewCacheVersion("aaa")).not.toBe(reviewCacheVersion("aab"));
    expect(reviewCacheVersion("aaa", "x")).not.toBe(reviewCacheVersion("aaa"));
    expect(reviewCacheVersion("aaa", "")).toBe(reviewCacheVersion("aaa"));
  });
});

describe("planEviction", () => {
  it("drops other versions first, then the least recently used beyond the limit", () => {
    const rows = [
      { key: "a", lastUsed: 5, version: "v2" },
      { key: "b", lastUsed: 1, version: "v2" },
      { key: "c", lastUsed: 3, version: "v2" },
      { key: "old", lastUsed: 99, version: "v1" },
    ];
    expect(planEviction(rows, "v2", 3).sort()).toEqual(["old"]);
    expect(planEviction(rows, "v2", 2).sort()).toEqual(["b", "old"]);
    expect(planEviction(rows, "v2", 0).sort()).toEqual(["a", "b", "c", "old"]);
  });
});

function stores(): Array<[string, () => { store: ReviewCacheStore; fail?: () => void }]> {
  return [
    ["memory", () => ({ store: createMemoryReviewCacheStore() })],
    ["indexeddb", () => ({ store: createIndexedDbReviewCacheStore(createFakeIndexedDb().factory) })],
  ];
}

describe.each(stores())("ReviewCache over the %s store", (_name, make) => {
  const entry = (cache: ReviewCache, ply: number, marker: number) => cache.save(START, MOVES, 1000, [{ ply, point: point(marker) }]);

  it("returns exactly what was saved, by ply", async () => {
    const { store } = make();
    const cache = new ReviewCache({ version: "v1", store });
    await entry(cache, 0, 10);
    await entry(cache, 2, 12);
    const hits = await cache.lookup(START, MOVES, 1000);
    expect([...hits.keys()].sort()).toEqual([0, 2]);
    expect(hits.get(2)).toEqual(point(12));
  });

  it("returns copies, so changing a hit does not change the stored point", async () => {
    const { store } = make();
    const cache = new ReviewCache({ version: "v1", store });
    await entry(cache, 0, 10);
    (await cache.lookup(START, MOVES, 1000)).get(0)!.final.bestMove = "zzzz";
    expect((await cache.lookup(START, MOVES, 1000)).get(0)!.final.bestMove).toBe("h2e2");
  });

  it("does not hit when the version, node count or history differs", async () => {
    const { store } = make();
    await entry(new ReviewCache({ version: "v1", store }), 1, 11);
    expect((await new ReviewCache({ version: "v1", store }).lookup(START, MOVES, 1000)).size).toBe(1);
    expect((await new ReviewCache({ version: "v2", store }).lookup(START, MOVES, 1000)).size).toBe(0);
    expect((await new ReviewCache({ version: "v1", store }).lookup(START, MOVES, 2000)).size).toBe(0);
    expect((await new ReviewCache({ version: "v1", store }).lookup(START, ["c3c4", "b9c7"], 1000)).size).toBe(0);
  });

  it("stores only points that are completely finished", async () => {
    const { store } = make();
    const cache = new ReviewCache({ version: "v1", store });
    await cache.save(START, MOVES, 1000, [{ ply: 0, point: point(1, false) }, { ply: 1, point: point(2, true) }]);
    expect([...(await cache.lookup(START, MOVES, 1000)).keys()]).toEqual([1]);
  });

  it("keeps at most the limit, evicting the least recently used", async () => {
    const { store } = make();
    let clock = 0;
    const cache = new ReviewCache({ version: "v1", store, maxEntries: 3, now: () => (clock += 1) });
    for (let ply = 0; ply < 3; ply += 1) await entry(cache, ply, ply);
    await cache.lookup(START, ["c3c4"], 1000); // touches ply 0 only
    await entry(cache, 3, 3);
    expect([...(await cache.lookup(START, MOVES, 1000)).keys()].sort()).toEqual([0, 2, 3]);
  });

  it("removes entries of other versions when it writes", async () => {
    const { store } = make();
    await entry(new ReviewCache({ version: "v1", store }), 0, 1);
    const next = new ReviewCache({ version: "v2", store });
    await entry(next, 1, 2);
    expect((await new ReviewCache({ version: "v1", store }).lookup(START, MOVES, 1000)).size).toBe(0);
  });
});

describe("ReviewCache failures", () => {
  const throwing: ReviewCacheStore = {
    read: () => Promise.reject(new Error("boom")),
    write: () => Promise.reject(new Error("boom")),
  };

  it("treats a failing read as a miss and a failing write as nothing", async () => {
    const cache = new ReviewCache({ version: "v1", store: throwing });
    expect((await cache.lookup(START, MOVES, 1000)).size).toBe(0);
    await expect(cache.save(START, MOVES, 1000, [{ ply: 0, point: point(1) }])).resolves.toBeUndefined();
  });

  it("treats a store that throws synchronously the same way", async () => {
    const cache = new ReviewCache({
      version: "v1",
      store: { read: () => { throw new Error("sync"); }, write: () => { throw new Error("sync"); } },
    });
    expect((await cache.lookup(START, MOVES, 1000)).size).toBe(0);
    await expect(cache.save(START, MOVES, 1000, [{ ply: 0, point: point(1) }])).resolves.toBeUndefined();
  });

  it("falls back to no cache when IndexedDB cannot be opened or is missing", async () => {
    const fake = createFakeIndexedDb();
    fake.failOpen = true;
    const blocked = new ReviewCache({ version: "v1", store: createIndexedDbReviewCacheStore(fake.factory) });
    expect((await blocked.lookup(START, MOVES, 1000)).size).toBe(0);
    await expect(blocked.save(START, MOVES, 1000, [{ ply: 0, point: point(1) }])).resolves.toBeUndefined();
    const missing = new ReviewCache({ version: "v1", store: createIndexedDbReviewCacheStore(undefined) });
    expect((await missing.lookup(START, MOVES, 1000)).size).toBe(0);
  });

  it("treats failing requests (quota) as nothing stored", async () => {
    const fake = createFakeIndexedDb();
    const cache = new ReviewCache({ version: "v1", store: createIndexedDbReviewCacheStore(fake.factory) });
    await cache.save(START, MOVES, 1000, [{ ply: 0, point: point(1) }]);
    fake.failRequests = true;
    await expect(cache.save(START, MOVES, 1000, [{ ply: 1, point: point(2) }])).resolves.toBeUndefined();
    expect((await cache.lookup(START, MOVES, 1000)).size).toBe(0);
    fake.failRequests = false;
    expect([...(await cache.lookup(START, MOVES, 1000)).keys()]).toEqual([0]);
  });
});

describe("createAppReviewCache", () => {
  it("uses the build hash, honours the test overrides, and can be switched off", async () => {
    expect(typeof __REVIEW_BUILD_HASH__).toBe("string");
    expect(__REVIEW_BUILD_HASH__.length).toBeGreaterThan(0);
    expect(createAppReviewCache("?review-cache=off", undefined)).toBeUndefined();
    const fake = createFakeIndexedDb();
    const normal = createAppReviewCache("", fake.factory)!;
    const other = createAppReviewCache("?review-cache-version=x", fake.factory)!;
    await normal.save(START, MOVES, 1000, [{ ply: 0, point: point(1) }]);
    expect((await normal.lookup(START, MOVES, 1000)).size).toBe(1);
    expect((await other.lookup(START, MOVES, 1000)).size).toBe(0);
  });
});

describe("deep pass budget (user decision 2026-10-23: 3x the quick budget)", () => {
  it("is three times the quick budget at every review budget", () => {
    expect(DEEP_NODE_MULTIPLIER).toBe(3);
    expect(deepNodeLimit(100_000)).toBe(300_000);
    expect(deepNodeLimit(1_000_000)).toBe(3_000_000);
    expect(deepNodeLimit(5_000_000)).toBe(15_000_000);
  });

  it("does not let results saved under the old 10x setting be read back", async () => {
    // Result cached by the 10x build (schema 1) must not match a key made now.
    const old = { ...base, version: reviewCacheVersion("aaa").replace(/^\d+\./, "1."), deepMultiplier: 10 };
    const now = { ...base, version: reviewCacheVersion("aaa"), deepMultiplier: DEEP_NODE_MULTIPLIER };
    expect(await reviewCacheKey(now)).not.toBe(await reviewCacheKey(old));
    expect(REVIEW_CACHE_SCHEMA).toBeGreaterThanOrEqual(2);
    expect(reviewCacheVersion("aaa")).not.toBe(old.version);
  });

  it("a cache filled by the 10x build misses in the 3x build", async () => {
    const store = createMemoryReviewCacheStore();
    const oldVersion = "1.aaa";
    const keys = await Promise.all(MOVES.map((_, ply) =>
      reviewCacheKey({ version: oldVersion, startFen: START, moves: MOVES, ply, quickNodeLimit: 1000, deepMultiplier: 10 })));
    await store.write(keys.map((key) => ({ key, point: point(1) })), { now: 1, version: oldVersion, maxEntries: 100 });
    const cache = new ReviewCache({ version: reviewCacheVersion("aaa"), store });
    expect((await cache.lookup(START, MOVES, 1000)).size).toBe(0);
  });
});
