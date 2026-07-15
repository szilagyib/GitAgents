import { describe, expect, it } from "vitest";
import { detectCppHeaderImpact } from "../src/cpp-impact";
import type { FileDiff } from "@gitagents/core";

describe("detectCppHeaderImpact", () => {
  it("flags header function declarations when no C/C++ source changes are present", () => {
    const findings = detectCppHeaderImpact({
      filePath: "include/parser.hpp",
      fileLines: ["int parse(const char* input);"],
      changedLines: [1],
      diffs: [
        {
          oldPath: "include/parser.hpp",
          newPath: "include/parser.hpp",
          deletedFile: false,
          newFile: false,
          renamedFile: false,
          diff: "+int parse(const char* input);",
        } satisfies FileDiff,
      ],
    });

    expect(findings[0].ruleId).toBe("header-api-impact");
    expect(findings[0].message).toContain("Function declaration");
  });

  it("does not flag header declarations when a C/C++ source file also changed", () => {
    const findings = detectCppHeaderImpact({
      filePath: "include/parser.hpp",
      fileLines: ["int parse(const char* input);"],
      changedLines: [1],
      diffs: [
        {
          oldPath: "include/parser.hpp",
          newPath: "include/parser.hpp",
          deletedFile: false,
          newFile: false,
          renamedFile: false,
          diff: "+int parse(const char* input);",
        } satisfies FileDiff,
        {
          oldPath: "src/parser.cpp",
          newPath: "src/parser.cpp",
          deletedFile: false,
          newFile: false,
          renamedFile: false,
          diff: "+int parse(const char* input) { return 0; }",
        } satisfies FileDiff,
      ],
    });

    expect(findings).toHaveLength(0);
  });

  it("flags header data member changes as cross-file impact", () => {
    const findings = detectCppHeaderImpact({
      filePath: "include/model.h",
      fileLines: ["int axleCount;"],
      changedLines: [1],
      diffs: [
        {
          oldPath: "include/model.h",
          newPath: "include/model.h",
          deletedFile: false,
          newFile: false,
          renamedFile: false,
          diff: "+int axleCount;",
        } satisfies FileDiff,
      ],
    });

    expect(findings[0].message).toContain("Data member declaration");
  });
});
