import { describe, expect, it } from "vitest";
import { GameLibrarySession } from "./game-library-session";
import type { SavedGame } from "./game-library";
import { STANDARD_START_FEN } from "./game-library";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function game(id: string, moves: string[]): SavedGame {
  return {
    id, savedAt: 1, moves, startFen: STANDARD_START_FEN, source: "played",
    importFormat: null, importMetadata: {}, importWarnings: [], variationTree: null,
  };
}

describe("game library session binding", () => {
  it("keeps the opened record bound when an earlier save completes later", async () => {
    const session = new GameLibrarySession();
    const pendingWrite = deferred();
    const saveA = session.saveAndBind(game("A", ["h2e2"]), () => pendingWrite.promise);

    session.open(game("B", ["h2e2", "h9g7"]));
    pendingWrite.resolve();

    expect(await saveA).toBe(false);
    expect(session.recordForMainline(["h2e2", "h9g7"])).toBe("B");
    expect(session.recordForMainline(["h2e2"])).toBeNull();
  });

  it("unbinds a saved record when the current mainline diverges", () => {
    const session = new GameLibrarySession();
    session.open(game("A", ["h2e2", "h9g7"]));

    expect(session.recordForMainline(["h2e2", "h9g7"])).toBe("A");
    session.mainlineChanged(["h2e2", "b7b3"]);
    expect(session.recordForMainline(["h2e2", "h9g7"])).toBeNull();
  });

  it("does not bind identical move lists from different root positions", () => {
    const session = new GameLibrarySession();
    const imported = { ...game("imported", ["h2e2"]), startFen: "custom FEN" };
    session.open(imported);

    expect(session.recordForMainline(["h2e2"], "custom FEN")).toBe("imported");
    expect(session.recordForMainline(["h2e2"], STANDARD_START_FEN)).toBeNull();
  });
});
