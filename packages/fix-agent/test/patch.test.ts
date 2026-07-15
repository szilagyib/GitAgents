import { describe, expect, it } from "vitest";
import { applyUnifiedDiff } from "../src/patch";

describe("applyUnifiedDiff", () => {
  const original = [
    "package com.example;",
    "",
    "public class App {",
    "    public String getName(User user) {",
    "        return user.getName();",
    "    }",
    "}",
  ].join("\n");

  it("applies a single-file unified diff", () => {
    const patch = [
      "--- a/src/App.java",
      "+++ b/src/App.java",
      "@@ -3,5 +3,6 @@",
      " public class App {",
      "     public String getName(User user) {",
      "+        if (user == null) return null;",
      "         return user.getName();",
      "     }",
      " }",
    ].join("\n");

    const result = applyUnifiedDiff(original, patch, "src/App.java");

    expect(result.valid).toBe(true);
    expect(result.content).toContain("if (user == null) return null;");
  });

  it("rejects patches for a different file", () => {
    const patch = [
      "--- a/src/Other.java",
      "+++ b/src/Other.java",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    const result = applyUnifiedDiff(original, patch, "src/App.java");

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("expected src/App.java");
  });

  it("rejects patches with stale context", () => {
    const patch = [
      "--- a/src/App.java",
      "+++ b/src/App.java",
      "@@ -4,2 +4,3 @@",
      "     public String getName(User user) {",
      "+        if (user == null) return null;",
      "         return account.getName();",
    ].join("\n");

    const result = applyUnifiedDiff(original, patch, "src/App.java");

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("mismatch");
  });

  it("preserves CRLF line endings", () => {
    const crlfOriginal = original.replace(/\n/g, "\r\n");
    const patch = [
      "--- a/src/App.java",
      "+++ b/src/App.java",
      "@@ -4,2 +4,3 @@",
      "     public String getName(User user) {",
      "+        if (user == null) return null;",
      "         return user.getName();",
    ].join("\n");

    const result = applyUnifiedDiff(crlfOriginal, patch, "src/App.java");

    expect(result.valid).toBe(true);
    expect(result.content).toContain("\r\n");
    expect(result.content).not.toContain(";\n");
  });
});
