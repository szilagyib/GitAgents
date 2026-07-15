import { describe, it, expect } from "vitest";
import { parseDiffHunks } from "../src/diff";

describe("parseDiffHunks", () => {
  it("classifies each line of a single hunk by kind and oldLine", () => {
    const diff = "@@ -1,3 +1,4 @@\n line1\n+line2\n line3\n line4";

    const result = parseDiffHunks(diff);

    expect(result.get(1)).toEqual({ kind: "context", oldLine: 1 });
    expect(result.get(2)).toEqual({ kind: "added" });
    expect(result.get(3)).toEqual({ kind: "context", oldLine: 2 });
    expect(result.get(4)).toEqual({ kind: "context", oldLine: 3 });
  });

  it("handles multiple hunks and skips deletions in the new-line map", () => {
    const diff = [
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+B",
      "@@ -10,2 +10,3 @@",
      " x",
      "+y",
      " z",
    ].join("\n");

    const result = parseDiffHunks(diff);

    expect(result.get(1)).toEqual({ kind: "context", oldLine: 1 });
    expect(result.get(2)).toEqual({ kind: "added" });
    expect(result.get(10)).toEqual({ kind: "context", oldLine: 10 });
    expect(result.get(11)).toEqual({ kind: "added" });
    expect(result.get(12)).toEqual({ kind: "context", oldLine: 11 });
  });

  it("returns undefined for lines not in any hunk", () => {
    const diff = "@@ -1,1 +1,2 @@\n a\n+b";

    const result = parseDiffHunks(diff);

    expect(result.get(99)).toBeUndefined();
  });

  it("returns an empty map for an empty diff", () => {
    expect(parseDiffHunks("").size).toBe(0);
  });
});
