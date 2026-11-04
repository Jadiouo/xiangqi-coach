import { STANDARD_START_FEN, type SavedGame } from "./game-library";

export class GameLibrarySession {
  private recordId: string | null = null;
  private recordMoves: string[] = [];
  private recordStartFen = STANDARD_START_FEN;
  private currentMoves: string[] = [];
  private currentStartFen = STANDARD_START_FEN;
  private revision = 0;

  open(game: SavedGame): void {
    this.revision += 1;
    this.recordId = game.id;
    this.recordMoves = [...game.moves];
    this.recordStartFen = game.startFen;
    this.currentMoves = [...game.moves];
    this.currentStartFen = game.startFen;
  }

  /** The library entry the game on the board is saved as, if it is still the same game. */
  boundRecordId(): string | null {
    return this.recordId;
  }

  /** Brings the binding back after a page reload: the game on the board is the saved entry `id`. */
  restore(id: string, moves: string[], startFen = STANDARD_START_FEN): void {
    this.revision += 1;
    this.recordId = id;
    this.recordMoves = [...moves];
    this.recordStartFen = startFen;
    this.currentMoves = [...moves];
    this.currentStartFen = startFen;
  }

  reset(): void {
    this.revision += 1;
    this.recordId = null;
    this.recordMoves = [];
    this.recordStartFen = STANDARD_START_FEN;
    this.currentMoves = [];
    this.currentStartFen = STANDARD_START_FEN;
  }

  mainlineChanged(moves: string[], startFen = STANDARD_START_FEN): void {
    if (sameMoves(this.currentMoves, moves) && this.currentStartFen === startFen) return;
    this.currentMoves = [...moves];
    this.currentStartFen = startFen;
    this.revision += 1;
    if (this.recordId && (!sameMoves(this.recordMoves, moves) || this.recordStartFen !== startFen)) {
      this.recordId = null;
      this.recordMoves = [];
      this.recordStartFen = STANDARD_START_FEN;
    }
  }

  recordForMainline(moves: string[], startFen = STANDARD_START_FEN): string | null {
    if (this.recordId && (!sameMoves(this.recordMoves, moves) || this.recordStartFen !== startFen)) {
      this.recordId = null;
      this.recordMoves = [];
      this.recordStartFen = STANDARD_START_FEN;
      this.revision += 1;
    }
    return this.recordId;
  }

  async saveAndBind(game: SavedGame, persist: () => Promise<void>): Promise<boolean> {
    const revision = this.revision;
    await persist();
    if (revision !== this.revision) return false;
    this.open(game);
    return true;
  }
}

function sameMoves(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((move, index) => move === right[index]);
}
