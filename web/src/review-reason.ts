import { zhTW } from "./locale/zh-TW";
import type { ReviewExplanationLevel, ReviewReason } from "./review-client";

export function createReviewReasonElement(
  reason: ReviewReason,
  level: ReviewExplanationLevel = "beginner",
): HTMLParagraphElement {
  const element = document.createElement("p");
  element.dataset.reviewReason = reason.kind;
  element.textContent = zhTW.review.reason(reason, level);
  return element;
}
