import { zhTW } from "./locale/zh-TW";
import type { ReviewComparison } from "./review-client";

/** The played-versus-best block of a review point; null for saves that predate it. */
export function createReviewComparisonElement(comparison: ReviewComparison | null | undefined): HTMLElement | null {
  if (!comparison) return null;
  const sentences = zhTW.review.comparison(comparison);
  const block = document.createElement("div");
  block.dataset.reviewComparison = "";
  for (const text of [sentences.played, sentences.best]) {
    const line = document.createElement("p");
    line.textContent = text;
    block.append(line);
  }
  return block;
}
