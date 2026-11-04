import { savedGameUserSide, type SavedGame } from "./game-library";
import { resultForUser } from "./my-side";
import { zhTW } from "./locale/zh-TW";

export interface LibraryRowParts {
  /** Win / loss / draw from the user's seat (a played game), or the plain result (an imported one); a dash when unknown. */
  result: string;
  /** "執紅" / "執黑"; null for an imported game, which has no user side. */
  side: string | null;
  /** "難度 N", or "難度 —" for a save from before the field existed; null for an imported game. */
  difficulty: string | null;
}

/** The facts every library row shows. Fields older saves lack come out as a dash rather than a guess. */
export function libraryRowParts(game: SavedGame): LibraryRowParts {
  const played = game.source === "played";
  const side = savedGameUserSide(game);
  const reviewedResult = game.reviewSnapshot?.result;
  const outcome = reviewedResult && reviewedResult !== "unknown" ? reviewedResult : game.outcome ?? null;
  let result: string = zhTW.library.resultUnknown;
  if (outcome === "ongoing") result = zhTW.library.resultOngoing;
  else if (outcome === "red_win" || outcome === "black_win" || outcome === "draw") {
    const mine = played ? resultForUser(outcome, side) : null;
    result = mine ? zhTW.library.resultForUser[mine] : zhTW.outcome[outcome];
  }
  return {
    result,
    side: played ? zhTW.library.sideLabel[side] : null,
    difficulty: played ? zhTW.library.difficulty(game.difficulty ?? null) : null,
  };
}
