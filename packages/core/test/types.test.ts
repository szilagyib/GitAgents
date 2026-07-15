import { describe, it, expect } from "vitest";
import {
  isFinding,
  normalizeFinding,
  isReviewArtifact,
  isFixResultArtifact,
  computeFingerprint,
} from "../src/types";

describe("isFinding", () => {
  it("returns true for a valid finding", () => {
    const finding = {
      line: 42, severity: "error" as const, confidence: "high" as const,
      ruleId: "null-safety", autoFixable: false,
      message: "Possible null dereference", codeContext: "user.getName()",
      suggestedApproach: "Add null check",
      fixStrategy: "local-null-guard",
      fixabilityReason: "A guard can prevent the dereference locally.",
    };
    expect(isFinding(finding)).toBe(true);
  });
  it("returns false for invalid fix strategy", () => {
    expect(isFinding({
      line: 42, severity: "error", confidence: "high", ruleId: "test",
      autoFixable: true, message: "msg", codeContext: "code", suggestedApproach: "fix",
      fixStrategy: "rewrite-everything",
    })).toBe(false);
  });
  it("normalizes invalid optional fix strategy instead of dropping the finding", () => {
    const finding = normalizeFinding({
      line: 42, severity: "error", confidence: "high", ruleId: "test",
      autoFixable: true, message: "msg", codeContext: "code", suggestedApproach: "fix",
      fixStrategy: "rewrite-everything",
    });
    expect(finding).not.toBeNull();
    expect(finding?.fixStrategy).toBeUndefined();
  });
  it("returns false for missing fields", () => { expect(isFinding({ line: 42 })).toBe(false); });
  it("preserves verified/gateEligible booleans when normalizing", () => {
    const finding = normalizeFinding({
      line: 42, severity: "error", confidence: "high", ruleId: "test",
      autoFixable: false, message: "msg", codeContext: "code", suggestedApproach: "fix",
      verified: true, gateEligible: false,
    });
    expect(finding?.verified).toBe(true);
    expect(finding?.gateEligible).toBe(false);
  });
  it("drops non-boolean verified/gateEligible when normalizing", () => {
    const finding = normalizeFinding({
      line: 42, severity: "error", confidence: "high", ruleId: "test",
      autoFixable: false, message: "msg", codeContext: "code", suggestedApproach: "fix",
      verified: "yes", gateEligible: 1,
    });
    expect(finding?.verified).toBeUndefined();
    expect(finding?.gateEligible).toBeUndefined();
  });
  it("returns false for invalid severity", () => {
    expect(isFinding({
      line: 42, severity: "critical", confidence: "high", ruleId: "test",
      autoFixable: false, message: "msg", codeContext: "code", suggestedApproach: "fix",
    })).toBe(false);
  });
});

const validReviewArtifact = {
  prNumber: 42, repoSlug: "grp/proj", timestamp: "2026-04-02T14:30:00Z",
  source: "review-agent" as const,
  files: [], totals: { errors: 0, warnings: 0 },
  gateResult: "pass" as const, commentMap: {},
};

describe("isReviewArtifact", () => {
  it("returns true for a valid artifact", () => {
    expect(isReviewArtifact(validReviewArtifact)).toBe(true);
  });

  it("accepts artifacts that still carry legacy fields", () => {
    const legacy = {
      prNumber: 42, repoSlug: "grp/proj", timestamp: "2026-04-02T14:30:00Z",
      source: "review-agent" as const,
      fixAttemptCount: 2,
      fixesApplied: true,
      appliedFixCount: 3,
      files: [], totals: { errors: 0, warnings: 0 },
      gateResult: "pass" as const, commentMap: {},
    };
    expect(isReviewArtifact(legacy)).toBe(true);
  });

  it("accepts an artifact carrying the new blocking/reviewStatus/rejected fields", () => {
    const artifact = {
      ...validReviewArtifact,
      reviewStatus: "completed" as const,
      blocking: [{ path: "A.java", line: 5, ruleId: "x", message: "m" }],
      rejected: [{ path: "B.java", line: 9, ruleId: "y", message: "m", reason: "unverified" }],
    };
    expect(isReviewArtifact(artifact)).toBe(true);
  });

  it("rejects an artifact whose blocking is not an array", () => {
    const bad = { ...validReviewArtifact, blocking: "nope" };
    expect(isReviewArtifact(bad)).toBe(false);
  });

  it("rejects an artifact whose reviewStatus is not a known value", () => {
    const bad = { ...validReviewArtifact, reviewStatus: "bogus" };
    expect(isReviewArtifact(bad)).toBe(false);
  });

  it("rejects an artifact whose repoSlug is not a string", () => {
    const bad = { ...validReviewArtifact, repoSlug: 123 };
    expect(isReviewArtifact(bad)).toBe(false);
  });
});

describe("isFixResultArtifact", () => {
  it("returns true for a valid fix-result artifact", () => {
    const artifact = {
      prNumber: 42,
      repoSlug: "grp/proj",
      timestamp: "2026-04-02T14:30:00Z",
      source: "fix-agent" as const,
      fixAttemptCount: 1,
      fixesApplied: true,
      appliedFixCount: 2,
      applied: [{ path: "A.java", line: 5, ruleId: "x", message: "m" }],
      skipped: [],
      manual: [],
    };
    expect(isFixResultArtifact(artifact)).toBe(true);
  });

  it("rejects an artifact with source 'review-agent'", () => {
    const bad = {
      prNumber: 42, repoSlug: "grp/proj", timestamp: "x",
      source: "review-agent",
      fixAttemptCount: 0, fixesApplied: false, appliedFixCount: 0,
      applied: [], skipped: [], manual: [],
    };
    expect(isFixResultArtifact(bad)).toBe(false);
  });
});

describe("computeFingerprint", () => {
  it("produces consistent fingerprints for the same anchor", () => {
    const fp1 = computeFingerprint(42, "null-safety", "src/App.java", "return x.y;");
    const fp2 = computeFingerprint(42, "null-safety", "src/App.java", "return x.y;");
    expect(fp1).toBe(fp2);
  });
  it("produces different fingerprints when the code context changes", () => {
    const fp1 = computeFingerprint(42, "null-safety", "src/App.java", "return x.y;");
    const fp2 = computeFingerprint(42, "null-safety", "src/App.java", "return a.b;");
    expect(fp1).not.toBe(fp2);
  });
  it("produces different fingerprints when the rule changes", () => {
    const fp1 = computeFingerprint(42, "null-safety", "src/App.java", "return x.y;");
    const fp2 = computeFingerprint(42, "off-by-one", "src/App.java", "return x.y;");
    expect(fp1).not.toBe(fp2);
  });
  it("is stable when the finding drifts to another line (same code)", () => {
    // The whole point of anchoring on code text: unrelated edits above a
    // finding must not re-fingerprint it into a resolve + re-post cycle.
    const fp1 = computeFingerprint(42, "null-safety", "src/App.java", "  return x.y;");
    const fp2 = computeFingerprint(42, "null-safety", "src/App.java", "return x.y;");
    expect(fp1).toBe(fp2);
  });
  it("produces base36 output that the marker pattern can match", () => {
    const fp = computeFingerprint(42, "null-safety", "src/App.java", "return x.y;");
    expect(fp).toMatch(/^[a-z0-9]+$/);
  });
});
