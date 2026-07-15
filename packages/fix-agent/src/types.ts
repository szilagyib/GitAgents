import type { Finding } from "@gitagents/core";

export interface FixResult {
  finding: Finding;
  filePath: string;
  fixedContent: string;
  applied: boolean;
  skipReason?: string;
}
