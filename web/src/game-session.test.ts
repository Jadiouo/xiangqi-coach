import { describe, expect, it } from "vitest";
import { computerToMove, playComputerMove, undoToUserTurn, type SessionGame } from "./game-session";

type Side = "red" | "black";

/** A stand-in that follows the wasm contract: moves alternate from red, history() is "ply|side|notation|iccs" lines. */
class FakeGame implements SessionGame {
  moves: string[] = [];
  aiCalls: Array<{ nodeLimit: number; level: number }> = [];
  over = false;
  side_to_move(): Side { return this.moves.length % 2 === 0 ? "red" : "black"; }
  history(): string {
    return this.moves.map((move, index) => `${index + 1}|${index % 2 === 0 ? "red" : "black"}|n|${move}`).join("\n");
  }
  outcome(): string { return this.over ? "red_win" : "ongoing"; }
  undo_last_move(): boolean { return this.moves.pop() !== undefined; }
  ai_move(nodeLimit: number, level: number): boolean {
    this.aiCalls.push({ nodeLimit, level });
    this.moves.push(`ai${this.moves.length}`);
    return true;
  }
  user(move: string): void { this.moves.push(move); }
}

describe("computer's turn", () => {
  it("is the side that is not the user's, while the game is on", () => {
    const game = new FakeGame();
    expect(computerToMove(game, "red")).toBe(false);
    expect(computerToMove(game, "black")).toBe(true);
    game.user("h2e2");
    expect(computerToMove(game, "red")).toBe(true);
    expect(computerToMove(game, "black")).toBe(false);
    game.over = true;
    expect(computerToMove(game, "red")).toBe(false);
  });
});

describe("the computer's first move when the user plays black", () => {
  it("is searched with the chosen difficulty and added to the game as red's first move", () => {
    const game = new FakeGame();
    expect(playComputerMove(game, "black", 100_000, 7)).toBe(true);
    expect(game.aiCalls).toEqual([{ nodeLimit: 100_000, level: 7 }]);
    expect(game.moves).toHaveLength(1);
    expect(game.side_to_move()).toBe("black");
  });

  it("does nothing when it is the user's turn", () => {
    const game = new FakeGame();
    expect(playComputerMove(game, "red", 100_000, 7)).toBe(false);
    expect(game.aiCalls).toEqual([]);
    expect(game.moves).toEqual([]);
  });
});

describe("undo takes back one turn (two plies) and stops at the user's move", () => {
  it("as red: removes the computer's reply and the user's move", () => {
    const game = new FakeGame();
    game.user("h2e2"); game.ai_move(1, 1); game.user("b2e2"); game.ai_move(1, 1);
    expect(undoToUserTurn(game, "red")).toBe(true);
    expect(game.moves).toHaveLength(2);
    expect(game.side_to_move()).toBe("red");
  });

  it("as black: from the position after the computer's reply, goes back two plies to a black-to-move position", () => {
    const game = new FakeGame();
    game.ai_move(1, 1); game.user("h9g7"); game.ai_move(1, 1);
    expect(game.side_to_move()).toBe("black");
    expect(undoToUserTurn(game, "black")).toBe(true);
    expect(game.moves).toHaveLength(1);
    expect(game.side_to_move()).toBe("black");
  });

  it("as black: when the game ended on the user's move, takes back only that move", () => {
    const game = new FakeGame();
    game.ai_move(1, 1); game.user("h9g7"); game.over = true;
    expect(undoToUserTurn(game, "black")).toBe(true);
    expect(game.moves).toHaveLength(1);
    expect(game.side_to_move()).toBe("black");
  });

  it("as black: refuses to take back the computer's first move", () => {
    const game = new FakeGame();
    game.ai_move(1, 1);
    expect(undoToUserTurn(game, "black")).toBe(false);
    expect(game.moves).toHaveLength(1);
  });

  it("as red: still takes back a lone first move", () => {
    const game = new FakeGame();
    game.user("h2e2");
    expect(undoToUserTurn(game, "red")).toBe(true);
    expect(game.moves).toHaveLength(0);
  });
});
