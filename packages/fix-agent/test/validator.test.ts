import { describe, it, expect } from "vitest";
import { validateFix, computeChangedRange } from "../src/validator";

describe("validateFix", () => {
  const original = [
    "package com.example;",
    "",
    "public class App {",
    "    public String getName(User user) {",
    "        return user.getName();",
    "    }",
    "}",
  ].join("\n");

  it("accepts a fix within the line window", () => {
    const fixed = [
      "package com.example;",
      "",
      "public class App {",
      "    public String getName(User user) {",
      "        if (user == null) return null;",
      "        return user.getName();",
      "    }",
      "}",
    ].join("\n");

    const result = validateFix(original, fixed, 5, 5);
    expect(result.valid).toBe(true);
  });

  it("rejects a fix that changes lines outside the window", () => {
    const fixed = [
      "package com.refactored;", // changed line 1 — way outside window
      "import java.util.Optional;", // added
      "",
      "public class App {",
      "    public Optional<String> getName(User user) {",
      "        return Optional.ofNullable(user).map(User::getName);",
      "    }",
      "}",
    ].join("\n");

    const result = validateFix(original, fixed, 5, 5);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("over-edit");
  });
});

describe("computeChangedRange", () => {
  it("returns null when the contents are identical", () => {
    expect(computeChangedRange("a\nb\nc\n", "a\nb\nc\n")).toBeNull();
  });

  it("returns null when contents differ only by trailing newline", () => {
    expect(computeChangedRange("a\nb", "a\nb\n")).toBeNull();
  });

  it("locates a single changed line", () => {
    const range = computeChangedRange("a\nb\nc\n", "a\nB\nc\n");
    expect(range).toEqual({ startLine: 2, endLine: 2, replacementLines: ["B"] });
  });

  it("locates a multi-line contiguous change", () => {
    const range = computeChangedRange("a\nb\nc\nd\n", "a\nX\nY\nd\n");
    expect(range).toEqual({ startLine: 2, endLine: 3, replacementLines: ["X", "Y"] });
  });

  it("spans an interior unchanged line so the range stays contiguous", () => {
    const range = computeChangedRange("a\nb\nc\nd\ne\n", "a\nB\nc\nD\ne\n");
    expect(range).toEqual({
      startLine: 2,
      endLine: 4,
      replacementLines: ["B", "c", "D"],
    });
  });

  it("represents a pure insertion by replacing the anchor line above it", () => {
    // Insert NEW between b (line 2) and c (line 3): anchor line 2, keep b then add NEW.
    const range = computeChangedRange("a\nb\nc\n", "a\nb\nNEW\nc\n");
    expect(range).toEqual({
      startLine: 2,
      endLine: 2,
      replacementLines: ["b", "NEW"],
    });
  });

  it("represents an insertion at the top by replacing the first line", () => {
    const range = computeChangedRange("a\nb\n", "NEW\na\nb\n");
    expect(range).toEqual({
      startLine: 1,
      endLine: 1,
      replacementLines: ["NEW", "a"],
    });
  });

  it("represents a pure deletion with an empty replacement", () => {
    const range = computeChangedRange("a\nb\nc\n", "a\nc\n");
    expect(range).toEqual({ startLine: 2, endLine: 2, replacementLines: [] });
  });

  it("returns LF-clean replacement lines for CRLF input", () => {
    const range = computeChangedRange(
      "a\r\nb\r\nc\r\n",
      "a\r\nB\r\nc\r\n"
    );
    expect(range).toEqual({ startLine: 2, endLine: 2, replacementLines: ["B"] });
  });
});
