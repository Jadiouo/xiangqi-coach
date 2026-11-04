import { expect, test } from "@playwright/test";
import { enableDevMode, openSettings, openTab } from "./helpers/nav";
import { openSettingsCategory } from "./helpers/nav";

const repetitionHistory = [
  "h0g2", "h9g7", "g2h0", "g7h9", "h0g2", "h9g7", "g2h0", "g7h9",
];

test("the game screen launches real review, selects a curve point and variation, and preserves cancelled work", async ({ page }) => {
  test.setTimeout(180_000);
  // Single worker: the point-by-point assertions below describe the sequential path; the pool has review-parallel.e2e.ts.
  await page.goto("/?review-workers=1");
  await openSettings(page);
  await page.getByLabel("電腦難度").selectOption("1");
  await enableDevMode(page);
  await openTab(page, "play");
  // Reach an actual recorded game history through the normal board controls.
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list code")).toHaveCount(2, { timeout: 30_000 });
  for (const [from, to] of [["b0", "c2"], ["h0", "g2"]]) {
    await page.locator(`[data-square="${from}"]`).click();
    await page.locator(`[data-square="${to}"]`).click();
    await expect(page.locator("#move-list code")).toHaveCount(from === "b0" ? 4 : 6, { timeout: 30_000 });
  }
  await openTab(page, "review");
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.getByRole("region", { name: "覆盤" })).toBeVisible();
  await expect(page.getByLabel("勝率曲線")).toBeVisible();
  await expect(page.locator("[data-review-point]").first()).toBeVisible({ timeout: 120_000 });
  await expect(page.locator("[data-review-point]").nth(1)).toBeVisible({ timeout: 120_000 });
  await page.waitForFunction(() => document.querySelector<HTMLElement>("#review-panel")?.dataset.continuationComplete === "true", null, { timeout: 120_000 });
  await expect(page.getByRole("button", { name: "選擇此變化" }).first()).toBeVisible();
  await page.locator("[data-review-point]").nth(1).click();
  await page.waitForFunction(() => document.querySelector<HTMLElement>("#review-panel")?.dataset.continuationComplete === "true", null, { timeout: 120_000 });
  const history = await page.locator("#move-list code").allTextContents();
  const terminalMetadata = await page.locator("[data-pv-continuation]").evaluateAll((lines) =>
    lines.map((line) => ({
      length: Number(line.getAttribute("data-pv-continuation-length")),
      terminal: line.getAttribute("data-pv-continuation-terminal"),
      status: line.getAttribute("data-pv-continuation-status"),
      audit: JSON.parse(line.parentElement?.querySelector<HTMLElement>("[data-pv-line]")?.dataset.pvReplayAudit ?? "{}"),
    })),
  );
  console.log("M7_PV_REPLAY_AUDIT", JSON.stringify({ history, terminalMetadata }));
  const pointOneFen = await page.evaluate(async (prefix) => {
    const module = await import("/wasm/xq_wasm.js") as { default: () => Promise<void>; WebGame: new () => { play(move: string): boolean; fen(): string } };
    await module.default();
    const game = new module.WebGame();
    for (const move of prefix) if (!game.play(move)) throw new Error(`illegal prefix ${move}`);
    return game.fen();
  }, history.slice(0, 1));
  expect(terminalMetadata.every((line) => line.audit.rootFen === pointOneFen
    && JSON.stringify(line.audit.rootHistory) === JSON.stringify(history.slice(0, 1))
    && Number.isInteger(line.audit.requestId))).toBe(true);
  expect(terminalMetadata.every((line) => line.status !== "pending")).toBe(true);
  expect(terminalMetadata.length).toBeGreaterThanOrEqual(3);
  expect(terminalMetadata.every((line) => (line.status === "terminal") === (line.terminal === "true"))).toBe(true);
  expect(terminalMetadata.every((line) => line.audit.rootMatchesReplayStart === true
    && (line.audit.failedIndex === null ? line.audit.replayedPv.length === line.audit.originalPv.length : line.status === "invalid_pv"))).toBe(true);

  const selectedPly = 0;
  const beforePoint = await page.locator("#board").getAttribute("data-fen");
  await page.locator("[data-review-point]").nth(selectedPly).click();
  await expect(page.locator("#board")).not.toHaveAttribute("data-fen", beforePoint!);

  const pvLines = await page.locator("[data-pv-line]").evaluateAll((lines) =>
    lines.map((line) => ({
      moves: line.textContent?.trim().split(/\s+/).filter(Boolean) ?? [],
      end: line.getAttribute("data-pv-end"),
      depth: line.getAttribute("data-pv-depth"),
      nodes: line.getAttribute("data-pv-nodes"),
      audit: JSON.parse(line.getAttribute("data-pv-replay-audit") ?? "{}"),
    })),
  );
  const continuationLines = await page.locator("[data-pv-continuation]").evaluateAll((lines) =>
    lines.map((line) => ({
      moves: JSON.parse(line.getAttribute("data-pv-continuation-moves") ?? "[]") as string[],
      length: Number(line.getAttribute("data-pv-continuation-length")),
      nodeLimit: Number(line.getAttribute("data-pv-continuation-node-limit")),
      terminal: line.getAttribute("data-pv-continuation-terminal"),
      status: line.getAttribute("data-pv-continuation-status"),
      depths: line.getAttribute("data-pv-continuation-depths")?.split(",").map(Number) ?? [],
    })),
  );
  expect(pvLines.length).toBeGreaterThanOrEqual(3);
  expect(continuationLines.length).toBe(pvLines.length);
  expect(pvLines.every((line) => line.end === "depth_limit" && Number(line.depth) >= 2)).toBe(true);
  expect(pvLines.every((line) => line.audit.failedIndex === null
    && line.audit.replayedPv.length === line.audit.originalPv.length)).toBe(true);
  const sixPlyLineIndex = continuationLines.findIndex((line, index) =>
    pvLines[index].moves.length + line.length >= 6,
  );
  expect(sixPlyLineIndex, "the selected nonterminal position has a replayable six-ply line").toBeGreaterThanOrEqual(0);
  expect(continuationLines.every((line) => line.nodeLimit === 20_000 && line.depths.every((depth) => depth >= 2))).toBe(true);

  const lineIndex = sixPlyLineIndex;
  const replayed = await page.evaluate(async ({ prefix, moves }) => {
    const module = await import("/wasm/xq_wasm.js") as { default: () => Promise<void>; WebGame: new () => { play(move: string): boolean; outcome(): string } };
    await module.default();
    const game = new module.WebGame();
    return [...prefix, ...moves].map((move) => ({ legal: game.play(move), outcome: game.outcome() }));
  }, { prefix: history.slice(0, selectedPly), moves: [...pvLines[lineIndex].moves, ...continuationLines[lineIndex].moves] });
  expect(replayed.length).toBeGreaterThanOrEqual(6);
  expect(replayed.every((step) => step.legal && step.outcome === "ongoing")).toBe(true);

  await page.getByRole("button", { name: "選擇此變化" }).nth(lineIndex).click();
  await expect(page.getByText("已選擇變化")).toBeVisible();

  const beforeCancel = await page.locator("[data-review-point]").count();
  expect(beforeCancel).toBeGreaterThanOrEqual(2);
  await page.locator("[data-review-point]").nth(1).click();
  const untouchedPointAuditIds = await page.locator("[data-pv-line]").evaluateAll((lines) =>
    lines.map((line) => JSON.parse(line.getAttribute("data-pv-replay-audit") ?? "{}").requestId as number),
  );
  await page.locator("[data-review-point]").nth(0).click();
  const focusedPointAuditIds = await page.locator("[data-pv-line]").evaluateAll((lines) =>
    lines.map((line) => JSON.parse(line.getAttribute("data-pv-replay-audit") ?? "{}").requestId as number),
  );
  await page.getByRole("button", { name: "取消分析" }).click();
  await expect(page.getByText("分析已取消")).toBeVisible({ timeout: 30_000 });
  const preservedAfterCancel = await page.locator("[data-review-point]").count();
  expect(preservedAfterCancel).toBeGreaterThanOrEqual(beforeCancel);
  await page.getByRole("button", { name: "想更久" }).click();
  await expect(page.locator("[data-review-point]")).toHaveCount(preservedAfterCancel);
  await page.waitForFunction(() =>
    document.querySelector<HTMLElement>("#review-panel [role=status]")?.textContent === "分析完成",
    null,
    { timeout: 120_000 },
  );
  const deeperPointAuditIds = await page.locator("[data-pv-line]").evaluateAll((lines) =>
    lines.map((line) => JSON.parse(line.getAttribute("data-pv-replay-audit") ?? "{}").requestId as number),
  );
  expect(deeperPointAuditIds.every((id, index) => id > focusedPointAuditIds[index])).toBe(true);
  await page.locator("[data-review-point]").nth(1).click();
  const preservedPointAuditIds = await page.locator("[data-pv-line]").evaluateAll((lines) =>
    lines.map((line) => JSON.parse(line.getAttribute("data-pv-replay-audit") ?? "{}").requestId as number),
  );
  expect(preservedPointAuditIds).toEqual(untouchedPointAuditIds);
  await page.locator("[data-review-point]").nth(0).click();
  await page.getByRole("button", { name: "重新分析" }).click();
  await expect(page.getByText("正在分析")).toBeVisible();
  await expect(page.getByRole("button", { name: "取消分析" })).toBeVisible();
  await expect(page.locator("[data-review-point]").first()).toBeVisible({ timeout: 120_000 });
  expect(await page.locator("[data-review-point]").count()).toBe(1);
});

test("review branches change the board, keep main history, and save a branch note", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await enableDevMode(page);
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list code")).toHaveCount(2, { timeout: 30_000 });
  const recordedHistory = await page.locator("#move-list code").allTextContents();

  await openTab(page, "review");
  await page.getByRole("button", { name: "開始覆盤" }).click();
  await expect(page.locator("[data-review-point]").first()).toBeVisible({ timeout: 120_000 });
  await page.locator("[data-review-point]").nth(0).click();
  const selectedFen = await page.locator("#board").getAttribute("data-fen");
  await page.locator('[data-square="b2"]').click();
  await page.locator('[data-square="e2"]').click();

  await expect(page.locator("#variation-tree [data-variation-node]")).toHaveCount(5, { timeout: 30_000 });
  await expect(page.locator("#board")).not.toHaveAttribute("data-fen", selectedFen!);
  // TEST_PLAN section 8.5: the engine answered the user's branch move (branch-1 is the user's, branch-2 the reply).
  await expect(page.locator('#variation-tree [data-variation-node="branch-2"]')).toBeVisible();
  expect(await page.locator("#move-list code").allTextContents()).toEqual(recordedHistory);
  const expectedBranchFen = await page.evaluate(async () => {
    const module = await import("/wasm/xq_wasm.js") as {
      default: () => Promise<void>;
      WebGame: new () => { play(move: string): boolean; fen(): string };
    };
    await module.default();
    const game = new module.WebGame();
    if (!game.play("b2e2")) throw new Error("expected branch move is illegal");
    return game.fen();
  });
  await page.locator('#variation-tree [data-variation-node="branch-1"]').click();
  await expect(page.locator("#board")).toHaveAttribute("data-fen", expectedBranchFen);
  await page.getByLabel("分支註解").fill("先用中炮控制中路");
  await page.getByRole("button", { name: "儲存註解" }).click();
  await expect(page.getByText("先用中炮控制中路")).toBeVisible();
  await openTab(page, "library");
  await page.getByRole("button", { name: "儲存棋局" }).click();
  await expect(page.locator("#game-library-list button")).toHaveCount(1);
});

test("live win probability is opt-in and updates once per real game turn, after the computer replied", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await openSettings(page);
  await openSettingsCategory(page, "advanced");
  await page.locator("#dev-mode-toggle").check();
  const toggle = page.getByRole("checkbox", { name: "即時勝率" });
  await expect(toggle).not.toBeChecked();
  await expect(page.locator("#live-win-probability")).toBeHidden();
  await openSettingsCategory(page, "play");
  await page.getByLabel("電腦難度").selectOption("1");
  await openSettingsCategory(page, "advanced");
  await toggle.check();
  await enableDevMode(page);
  await expect(page.locator("#live-win-probability")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#live-win-probability")).toHaveAttribute("data-evaluation-count", "1");
  await page.locator('[data-square="h2"]').click();
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator("#move-list code")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator("#live-win-probability")).toHaveAttribute("data-evaluation-count", "2", { timeout: 15_000 });
  const meter = await page.locator("#live-win-probability").evaluate((element) => ({
    side: element.getAttribute("data-evaluation-side"),
    fen: element.getAttribute("data-evaluation-fen"),
    value: Number(element.getAttribute("aria-valuenow")),
    events: JSON.parse(element.getAttribute("data-evaluation-history") ?? "[]") as Array<{ side: string; fen: string }>,
    assisted: element.getAttribute("data-assisted"),
  }));
  expect(meter.side).toBe("red");
  expect(meter.fen).toBe(await page.locator("#board").getAttribute("data-fen"));
  expect(meter.value).toBeGreaterThanOrEqual(0);
  expect(meter.value).toBeLessThanOrEqual(100);
  expect(meter.events.map((entry) => entry.side)).toEqual(["red", "red"]);
  expect(meter.events[0].fen).not.toBe(meter.events[1].fen);
  expect(meter.events[1].fen).toBe(await page.locator("#board").getAttribute("data-fen"));
  expect(meter.assisted).toBe("true");
});

async function createReviewClient(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(async () => {
    const { ReviewWorkerClient } = await import("/src/review-client.ts");
    const worker = new Worker(new URL("/src/review.worker.ts", location.origin), { type: "module" });
    const updates: unknown[] = [];
    const timeline: unknown[] = [];
    const client = new ReviewWorkerClient(worker, (state) => {
      updates.push(state);
      timeline.push({ at: performance.now(), status: state.status, points: state.points.length,
        lastStepDurationMs: state.lastStepDurationMs, cancelLatencyMs: state.cancelLatencyMs });
    });
    Object.assign(window, { __m7ReviewClient: client, __m7ReviewUpdates: updates, __m7ReviewTimeline: timeline });
  });
}

test("review worker cancels at a point boundary, keeps completed points, and ignores replaced job events", async ({ page }) => {
  await createReviewClient(page);
  const firstId = await page.evaluate((moves) => {
    const client = (window as Window & { __m7ReviewClient: { start(moves: string[], nodes: number): number } }).__m7ReviewClient;
    return client.start(moves, 4_000);
  }, repetitionHistory);
  await page.waitForFunction((id) => {
    const client = (window as Window & { __m7ReviewClient: { state: { id: number; points: unknown[] } | null } }).__m7ReviewClient;
    return client.state?.id === id && client.state.points.length >= 1;
  }, firstId, { timeout: 30_000 });

  const cancelSentAt = await page.evaluate(() => {
    const sentAt = performance.now();
    (window as Window & { __m7CancelSentAt?: number }).__m7CancelSentAt = sentAt;
    (window as Window & { __m7ReviewClient: { cancel(): void } }).__m7ReviewClient.cancel();
    return sentAt;
  });
  try {
    await page.waitForFunction((id) => {
      const state = (window as Window & { __m7ReviewClient: { state: { id: number; status: string } | null } }).__m7ReviewClient.state;
      return state?.id === id && state.status === "cancelled";
    }, firstId, { timeout: 5_000 });
  } catch (error) {
    const trace = await page.evaluate(() => (window as Window & { __m7ReviewTimeline: unknown[] }).__m7ReviewTimeline);
    console.error("M7_CANCEL_TIMELINE", JSON.stringify(trace));
    throw error;
  }
  const cancelTrace = await page.evaluate((sentAt) => {
    const timeline = (window as Window & { __m7ReviewTimeline: Array<{ at: number; status: string; points: number; lastStepDurationMs?: number; cancelLatencyMs?: number }> }).__m7ReviewTimeline;
    const terminal = timeline.findLast((entry) => entry.status === "cancelled");
    return {
      elapsedMs: terminal ? terminal.at - sentAt : null,
      maxStepMs: Math.max(...timeline.map((entry) => entry.lastStepDurationMs ?? 0)),
      timeline,
    };
  }, cancelSentAt);
  console.log("M7_CANCEL_SUCCESS", JSON.stringify(cancelTrace));
  expect(cancelTrace.elapsedMs).toBeLessThan(5_000);
  expect(cancelTrace.maxStepMs).toBeLessThan(5_000);
  const retained = await page.evaluate(() => {
    return (window as Window & { __m7ReviewClient: { state: { points: unknown[] } } }).__m7ReviewClient.state.points.length;
  });
  expect(retained).toBeGreaterThan(0);
  const interruptedStatuses = await page.evaluate(() => {
    const client = (window as unknown as { __m7ReviewClient: { state: { points: Array<{ quick: { candidates: Array<{ continuationStatus: string }> } }> } } }).__m7ReviewClient;
    return client.state.points.flatMap((point) => point.quick.candidates.map((candidate) => candidate.continuationStatus));
  });
  expect(interruptedStatuses.some((status) => status === "cancelled")).toBe(true);

  const secondId = await page.evaluate(() => {
    const client = (window as Window & { __m7ReviewClient: { start(moves: string[], nodes: number): number } }).__m7ReviewClient;
    return client.start([], 4_000);
  });
  await page.waitForFunction((id) => {
    const state = (window as Window & { __m7ReviewClient: { state: { id: number; status: string } | null } }).__m7ReviewClient.state;
    return state?.id === id && state.status === "complete";
  }, secondId, { timeout: 10_000 });
  const latest = await page.evaluate(() => {
    const client = (window as Window & { __m7ReviewClient: { state: { id: number; status: string; points: unknown[] } } }).__m7ReviewClient;
    return client.state;
  });
  expect(latest).toEqual({ id: secondId, status: "complete", points: [] });
});

test("review worker sends the real analyzer's repetition-aware result and observed PV metadata", async ({ page }) => {
  test.setTimeout(180_000);
  await createReviewClient(page);
  const startedAt = await page.evaluate(() => performance.now());
  const id = await page.evaluate((moves) => {
    const client = (window as Window & { __m7ReviewClient: { start(moves: string[], nodes: number): number } }).__m7ReviewClient;
    return client.start(moves, 4_000);
  }, repetitionHistory);
  await page.waitForFunction((requestId) => {
    const state = (window as Window & { __m7ReviewClient: { state: { id: number; status: string; points: Array<{ quick: { playedScore: { centipawns: number } } }> } | null } }).__m7ReviewClient.state;
    return state?.id === requestId && state.status === "complete" && state.points.length === 8;
  }, id, { timeout: 120_000 });
  const completionTrace = await page.evaluate((startedAt) => {
    const client = (window as unknown as { __m7ReviewClient: { state: { status: string; points: unknown[] } } }).__m7ReviewClient;
    const timeline = (window as Window & { __m7ReviewTimeline: Array<{ at: number; status: string; points: number; lastStepDurationMs?: number }> }).__m7ReviewTimeline;
    return {
      elapsedMs: performance.now() - startedAt,
      status: client.state.status,
      points: client.state.points.length,
      maxStepMs: Math.max(...timeline.map((entry) => entry.lastStepDurationMs ?? 0)),
    };
  }, startedAt);
  console.log("M7_REPETITION_COMPLETE", JSON.stringify(completionTrace));
  expect(completionTrace.status).toBe("complete");
  expect(completionTrace.points).toBe(8);
  const finalPoint = await page.evaluate(() => {
    const client = (window as unknown as { __m7ReviewClient: any }).__m7ReviewClient;
    return client.state.points[7].quick;
  });
  if (process.env.M7_CAPTURE_TRACE === "1") {
    console.log("M7_REVIEW_PV_TRACE", JSON.stringify(finalPoint.candidates[0]));
  }
  expect(finalPoint.playedScore.centipawns).toBe(0);
  expect(finalPoint.candidates[0].pv[0]).toBe(finalPoint.candidates[0].move);
  expect(finalPoint.candidates[0].pv.length).toBeGreaterThan(0);
  expect(finalPoint.candidates[0].pvEnd).toBeTruthy();
});
