import { minimatch } from "minimatch";
import type { FileReview, Suppression } from "@gitagents/core";

export interface SuppressionResult {
  fileReviews: FileReview[];
  suppressedCount: number;
}

/**
 * Drop findings that a repo's review-context.json suppresses. A finding is
 * suppressed when its ruleId matches a suppression whose pathPattern (minimatch)
 * matches the finding's file — the same semantics the review prompt advertises,
 * now enforced in code so a suppression cannot leak into the gate.
 */
export function applySuppressions(
  fileReviews: FileReview[],
  suppressions: Suppression[]
): SuppressionResult {
  if (suppressions.length === 0) {
    return { fileReviews, suppressedCount: 0 };
  }

  let suppressedCount = 0;
  const filtered = fileReviews.map((fileReview) => {
    const findings = fileReview.findings.filter((finding) => {
      const suppressed = suppressions.some(
        (s) => s.ruleId === finding.ruleId && minimatch(fileReview.path, s.pathPattern)
      );
      if (suppressed) suppressedCount++;
      return !suppressed;
    });
    return { ...fileReview, findings };
  });

  return { fileReviews: filtered, suppressedCount };
}
