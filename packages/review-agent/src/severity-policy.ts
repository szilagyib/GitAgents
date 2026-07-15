import type { Finding, RuleMap, FileReview, BlockingRef } from "@gitagents/core";

/**
 * Static-check rule IDs that are mechanically verifiable enough to gate a merge.
 * Everything else a static check emits is advisory. Model-authored findings get
 * their gate eligibility from the rule's `gate` flag instead (see applyGatePolicy).
 */
export const STATIC_GATE_ELIGIBLE: Set<string> = new Set([
  "merge-conflict-marker",
  "focused-test",
  "debugger-statement",
]);

/**
 * Stamp `gateEligible` on each finding. A finding is gate-eligible when its rule
 * declares `gate: true`; for findings whose ruleId is not in the rule map (static
 * checks), eligibility falls back to the STATIC_GATE_ELIGIBLE set.
 */
export function applyGatePolicy(findings: Finding[], rules: RuleMap): Finding[] {
  return findings.map((finding) => {
    const rule = rules.get(finding.ruleId);
    const gateEligible = rule
      ? rule.gate === true
      : STATIC_GATE_ELIGIBLE.has(finding.ruleId);
    return { ...finding, gateEligible };
  });
}

/**
 * Deterministic static-check findings whose rule is in STATIC_GATE_ELIGIBLE are
 * mechanically certain: they are stamped `verified` in code and must never be
 * sent to the model verifier, whose whole job is refutation — a skeptical model
 * must not be able to delete a real merge-conflict marker. The `origin` check
 * matters: model findings can cite these ruleIds too, but never carry origin
 * (normalizeFinding does not copy it), so they still go through verification.
 */
export function isMechanicallyVerified(finding: Finding): boolean {
  return finding.origin === "static" && STATIC_GATE_ELIGIBLE.has(finding.ruleId);
}

/**
 * A finding may block a merge only when it is a high-confidence error, its rule
 * is gate-eligible, AND it survived adversarial verification. All four conditions
 * are enforced in code — never inferred from the model's self-grade alone.
 */
export function isBlocking(finding: Finding): boolean {
  return (
    finding.severity === "error" &&
    finding.confidence === "high" &&
    finding.gateEligible === true &&
    finding.verified === true
  );
}

/** Flatten all blocking findings across files into the artifact's blocking[] refs. */
export function computeBlocking(fileReviews: FileReview[]): BlockingRef[] {
  return fileReviews.flatMap((fileReview) =>
    fileReview.findings.filter(isBlocking).map((finding) => ({
      path: fileReview.path,
      line: finding.line,
      ruleId: finding.ruleId,
      message: finding.message,
    }))
  );
}
