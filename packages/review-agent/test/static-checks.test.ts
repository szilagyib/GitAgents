import { describe, expect, it } from "vitest";
import { runStaticChecks } from "../src/static-checks";

describe("runStaticChecks", () => {
  it("flags merge conflict markers", () => {
    const findings = runStaticChecks("src/App.ts", ["<<<<<<< HEAD"], [1]);
    expect(findings[0].ruleId).toBe("merge-conflict-marker");
    expect(findings[0].severity).toBe("error");
    expect(findings[0].confidence).toBe("high");
  });

  it("does not flag a lone ======= (Markdown setext underline) as a conflict marker", () => {
    const findings = runStaticChecks(
      "docs/README.md",
      ["Section Title", "=======", "", "Body text."],
      [2]
    );
    expect(findings.find((f) => f.ruleId === "merge-conflict-marker")).toBeUndefined();
  });

  it("flags ======= when an angle conflict marker is within +/-3 lines", () => {
    const findings = runStaticChecks(
      "src/App.ts",
      ["<<<<<<< HEAD", "const a = 1;", "=======", "const a = 2;", ">>>>>>> branch"],
      [3]
    );
    expect(findings[0].ruleId).toBe("merge-conflict-marker");
  });

  it("flags focused tests", () => {
    const findings = runStaticChecks("src/App.test.ts", ["describe.only('x', () => {})"], [1]);
    expect(findings[0].ruleId).toBe("focused-test");
    expect(findings[0].fixStrategy).toBe("remove-focused-test");
    expect(findings[0].fixabilityReason).toContain("Removing .only");
  });

  it("flags empty catch blocks", () => {
    const findings = runStaticChecks(
      "src/App.ts",
      ["try {", "  work();", "} catch (error) {", "}"],
      [3]
    );
    expect(findings[0].ruleId).toBe("empty-catch");
  });

  it("does not flag console.log in tests", () => {
    const findings = runStaticChecks("src/App.test.ts", ["console.log(value);"], [1]);
    expect(findings).toHaveLength(0);
  });

  it("flags Java string reference comparison at medium confidence", () => {
    const findings = runStaticChecks("src/App.java", ["if (name == \"admin\") {"], [1]);
    expect(findings[0].ruleId).toBe("string-comparison");
    expect(findings[0].confidence).toBe("medium");
  });

  it("flags unguarded Optional.get", () => {
    const findings = runStaticChecks("src/App.java", ["String name = userName.get();"], [1]);
    expect(findings[0].ruleId).toBe("optional-usage");
  });

  it("does not flag Optional.get with a nearby presence guard", () => {
    const findings = runStaticChecks(
      "src/App.java",
      ["if (userName.isPresent()) {", "String name = userName.get();"],
      [2]
    );
    expect(findings.find((finding) => finding.ruleId === "optional-usage")).toBeUndefined();
  });

  it("flags likely floating promises", () => {
    const findings = runStaticChecks("src/app.ts", ["saveUserAsync(user);"], [1]);
    expect(findings[0].ruleId).toBe("async-errors");
  });

  it("flags loose equality in TypeScript", () => {
    const findings = runStaticChecks("src/app.ts", ["if (count == 0) return;"], [1]);
    expect(findings[0].ruleId).toBe("strict-typing");
  });

  it("does not flag intentional nullish loose equality", () => {
    const findings = runStaticChecks("src/app.ts", ["if (value == null) return;"], [1]);
    expect(findings.find((finding) => finding.ruleId === "strict-typing")).toBeUndefined();
  });

  it("flags unsafe C string APIs", () => {
    const findings = runStaticChecks("src/parser.c", ["strcpy(buffer, input);"], [1]);
    expect(findings[0].ruleId).toBe("buffer-bounds");
  });

  it("flags variable C/C++ format strings", () => {
    const findings = runStaticChecks("src/log.cpp", ["printf(message);"], [1]);
    expect(findings[0].ruleId).toBe("format-string");
  });

  it("does not flag literal fprintf format strings", () => {
    const findings = runStaticChecks("src/log.cpp", ["fprintf(stderr, \"%s\", message);"], [1]);
    expect(findings.find((finding) => finding.ruleId === "format-string")).toBeUndefined();
  });

  it("flags non-portable C++ aggregate headers", () => {
    const findings = runStaticChecks("src/main.cpp", ["#include <bits/stdc++.h>"], [1]);
    expect(findings[0].ruleId).toBe("portability");
  });

  it("flags sizeof(pointer) in byte-count operations", () => {
    const findings = runStaticChecks(
      "src/parser.c",
      ["void parse(char *buffer, const char *input) {", "  memcpy(buffer, input, sizeof(buffer));", "}"],
      [2]
    );
    expect(findings[0].ruleId).toBe("buffer-bounds");
    expect(findings[0].message).toContain("sizeof is applied to a pointer");
  });

  it("does not flag sizeof on local arrays", () => {
    const findings = runStaticChecks(
      "src/parser.c",
      ["char buffer[32];", "memset(buffer, 0, sizeof(buffer));"],
      [2]
    );
    expect(findings.find((finding) => finding.message.includes("sizeof is applied"))).toBeUndefined();
  });

  it("flags delete used for new[] allocations", () => {
    const findings = runStaticChecks(
      "src/main.cpp",
      ["int* values = new int[10];", "delete values;"],
      [2]
    );
    expect(findings[0].ruleId).toBe("memory-lifetime");
  });

  it("flags delete[] used for scalar new allocations", () => {
    const findings = runStaticChecks(
      "src/main.cpp",
      ["Widget* widget = new Widget();", "delete[] widget;"],
      [2]
    );
    expect(findings[0].ruleId).toBe("memory-lifetime");
  });

  it("demotes heuristic method-name/loose-equality checks to medium confidence", () => {
    const optional = runStaticChecks("src/App.java", ["String name = userName.get();"], [1]);
    expect(optional[0].ruleId).toBe("optional-usage");
    expect(optional[0].confidence).toBe("medium");

    const loose = runStaticChecks("src/app.ts", ["if (count == 0) return;"], [1]);
    expect(loose[0].ruleId).toBe("strict-typing");
    expect(loose[0].confidence).toBe("medium");

    const format = runStaticChecks("src/log.cpp", ["printf(message);"], [1]);
    expect(format[0].ruleId).toBe("format-string");
    expect(format[0].confidence).toBe("medium");
  });

  it("keeps merge-conflict, focused-test and debugger checks at error + high", () => {
    const focused = runStaticChecks("src/app.test.ts", ["it.only('x', () => {})"], [1]);
    expect(focused[0].confidence).toBe("high");
    expect(focused[0].severity).toBe("error");

    const debug = runStaticChecks("src/app.ts", ["  debugger;"], [1]);
    expect(debug[0].ruleId).toBe("debugger-statement");
    expect(debug[0].confidence).toBe("high");
  });
});
