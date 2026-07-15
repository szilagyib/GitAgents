import { describe, it, expect } from "vitest";
import {
  buildFixSummary,
  buildSuggestSummary,
  shouldAddManualLabel,
  FIX_SUMMARY_MARKER,
  type FindingRef,
  type SkippedRef,
  type MarkedRef,
  type FallbackRef,
} from "../src/summary";
import { suggestionMarker } from "../src/markers";

const f = (
  path: string,
  line: number,
  ruleId: string,
  message: string
): FindingRef => ({ path, line, ruleId, message });

const s = (
  path: string,
  line: number,
  ruleId: string,
  message: string,
  reason: string
): SkippedRef => ({ path, line, ruleId, message, reason });

describe("buildFixSummary", () => {
  it("includes a Fixed section listing applied findings", () => {
    const summary = buildFixSummary({
      applied: [f("src/A.java", 10, "npe", "Null guard missing")],
      skipped: [],
      manual: [],
    });
    expect(summary).toContain("**Fixed");
    expect(summary).toContain("`src/A.java:10`");
    expect(summary).toContain("npe");
    expect(summary).toContain("Null guard missing");
  });

  it("includes a For you section listing manual + skipped findings with reasons", () => {
    const summary = buildFixSummary({
      applied: [],
      skipped: [s("src/B.java", 5, "ioobe", "Bounds check", "fix too broad")],
      manual: [f("src/C.java", 3, "rename", "Bad variable name")],
    });
    expect(summary).toContain("**For you");
    expect(summary).toContain("`src/B.java:5`");
    expect(summary).toContain("fix too broad");
    expect(summary).toContain("`src/C.java:3`");
    expect(summary).toContain("Bad variable name");
  });

  it("omits the Fixed section when nothing was applied", () => {
    const summary = buildFixSummary({
      applied: [],
      skipped: [],
      manual: [f("src/A.java", 1, "x", "y")],
    });
    expect(summary).not.toContain("**Fixed");
  });

  it("omits the For you section when nothing remains", () => {
    const summary = buildFixSummary({
      applied: [f("src/A.java", 1, "x", "y")],
      skipped: [],
      manual: [],
    });
    expect(summary).not.toContain("**For you");
  });

  it("shows prepared fixes separately when push failed", () => {
    const summary = buildFixSummary({
      applied: [f("src/A.java", 10, "npe", "Null guard missing")],
      skipped: [],
      manual: [],
      pushError: "403 not allowed",
    });
    expect(summary).toContain("**Prepared but not pushed");
    expect(summary).toContain("`git push`");
    expect(summary).toContain("403 not allowed");
  });
});

describe("buildSuggestSummary", () => {
  const m = (
    path: string,
    line: number,
    ruleId: string,
    message: string,
    fingerprint: string
  ): MarkedRef => ({ path, line, ruleId, message, fingerprint });

  const fb = (
    path: string,
    line: number,
    ruleId: string,
    message: string,
    replacementLines: string[],
    fingerprint = "fp1"
  ): FallbackRef => ({ path, line, ruleId, message, replacementLines, fingerprint });

  const empty = {
    posted: [],
    alreadySuggested: [],
    fallbacks: [],
    skipped: [],
    manual: [],
  };

  it("lists posted suggestions", () => {
    const summary = buildSuggestSummary({
      ...empty,
      posted: [f("src/A.ts", 10, "npe", "Possible null deref")],
    });
    expect(summary).toContain("Suggested");
    expect(summary).toContain("`src/A.ts:10`");
    expect(summary).toContain("npe");
  });

  it("lists already-suggested findings separately", () => {
    const summary = buildSuggestSummary({
      ...empty,
      alreadySuggested: [m("src/A.ts", 10, "npe", "Possible null deref", "abc1")],
    });
    expect(summary).toContain("Already suggested");
    expect(summary).toContain("`src/A.ts:10`");
  });

  it("renders fallback patches as fenced code blocks", () => {
    const summary = buildSuggestSummary({
      ...empty,
      fallbacks: [fb("src/A.ts", 10, "npe", "Possible null deref", ["  if (x) return;", "  return x.y;"])],
    });
    expect(summary).toContain("`src/A.ts:10`");
    expect(summary).toContain("```");
    expect(summary).toContain("if (x) return;");
    expect(summary).toContain("return x.y;");
  });

  it("lists findings that could not be fixed with their reason", () => {
    const summary = buildSuggestSummary({
      ...empty,
      skipped: [s("src/B.ts", 5, "npe", "Possible null deref", "no safe patch returned")],
    });
    expect(summary).toContain("`src/B.ts:5`");
    expect(summary).toContain("no safe patch returned");
  });

  it("escalates manual findings so suggest mode keeps the human channel", () => {
    const summary = buildSuggestSummary({
      ...empty,
      manual: [f("src/C.ts", 7, "authorization", "Missing permission check")],
    });
    expect(summary).toContain("Needs manual attention");
    expect(summary).toContain("`src/C.ts:7`");
  });

  it("persists dedup markers for fallbacks and already-suggested findings", () => {
    // Fallbacks have no inline thread of their own, so their marker must live
    // in the summary or the next run recomputes the same Claude fix.
    const summary = buildSuggestSummary({
      ...empty,
      alreadySuggested: [m("src/A.ts", 10, "npe", "x", "aaa1")],
      fallbacks: [fb("src/B.ts", 20, "npe", "y", ["patched"], "bbb2")],
    });
    expect(summary).toContain(suggestionMarker("aaa1"));
    expect(summary).toContain(suggestionMarker("bbb2"));
  });

  it("does not emit markers for posted suggestions (their inline comment carries it)", () => {
    const summary = buildSuggestSummary({
      ...empty,
      posted: [f("src/A.ts", 10, "npe", "Possible null deref")],
    });
    expect(summary).not.toContain("gitagents:suggestion:");
  });

  it("returns an empty string when there is nothing to report", () => {
    expect(buildSuggestSummary(empty)).toBe("");
  });
});

describe("FIX_SUMMARY_MARKER", () => {
  it("is a stable hidden HTML comment marker", () => {
    expect(FIX_SUMMARY_MARKER).toBe("<!-- gitagents:summary:fix -->");
  });
});

describe("shouldAddManualLabel", () => {
  it("is true when any finding is skipped or manual", () => {
    expect(
      shouldAddManualLabel({
        skipped: [s("a", 1, "r", "m", "reason")],
        manual: [],
      })
    ).toBe(true);
    expect(
      shouldAddManualLabel({
        skipped: [],
        manual: [f("a", 1, "r", "m")],
      })
    ).toBe(true);
  });

  it("is false when everything was fixed", () => {
    expect(shouldAddManualLabel({ skipped: [], manual: [] })).toBe(false);
  });

  it("is true when fixes were prepared but push failed", () => {
    expect(
      shouldAddManualLabel({ skipped: [], manual: [], pushError: "403" })
    ).toBe(true);
  });
});
