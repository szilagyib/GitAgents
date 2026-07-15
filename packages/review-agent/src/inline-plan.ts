import type { Finding } from "@gitagents/core";
import { isBlocking } from "./severity-policy.js";

/**
 * Inline-comment priority, lowest number posts first:
 *   0 blocking, 1 error+high, 2 error, 3 warning.
 */
export function inlinePriority(finding: Finding): number {
  if (isBlocking(finding)) return 0;
  if (finding.severity === "error" && finding.confidence === "high") return 1;
  if (finding.severity === "error") return 2;
  return 3;
}

export interface InlineSplit<T> {
  toPost: T[];
  overflow: T[];
}

/**
 * Order candidates by inline priority (stable within a priority band) and split
 * at `cap`. Overflow items are not posted inline — the caller lists them in the
 * summary instead.
 */
export function planInlineComments<T extends { finding: Finding }>(
  items: T[],
  cap: number
): InlineSplit<T> {
  const ordered = [...items].sort(
    (a, b) => inlinePriority(a.finding) - inlinePriority(b.finding)
  );
  return { toPost: ordered.slice(0, cap), overflow: ordered.slice(cap) };
}
