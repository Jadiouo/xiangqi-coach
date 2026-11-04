import { zhTW } from "./locale/zh-TW";

/** The "N played, M counted" line of the level settings; empty before any game was played. */
export function playedCountText(view: { played: number; counted: number; assisted: number; manual: boolean; reviewing: boolean }): string {
  if (view.played === 0 && view.assisted === 0) return "";
  const text = view.manual ? zhTW.review.playedCountManual(view.played) : zhTW.review.playedCount(view.played, view.counted);
  const assisted = view.assisted > 0 ? zhTW.review.playedAssisted(view.assisted) : "";
  const reviewing = !view.manual && view.reviewing ? `（${zhTW.review.backgroundReviewing}）` : "";
  return `${text}${assisted}${reviewing}`;
}
