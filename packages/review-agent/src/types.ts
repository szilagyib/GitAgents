import type { FileReview, RejectedFinding } from "@gitagents/core";

export interface OrchestratorResult {
  fileReviews: FileReview[];
  errors: Array<{ filePath: string; error: string }>;
  rateLimited: boolean;
  /** Findings dropped by the adversarial verification pass, kept for the artifact. */
  rejected: RejectedFinding[];
}
