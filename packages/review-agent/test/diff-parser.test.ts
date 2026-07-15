import { describe, it, expect } from "vitest";
import { parseHunks, buildHybridContext } from "../src/diff-parser";

const SAMPLE_DIFF = `@@ -1,5 +1,6 @@
 package com.example;
+import java.util.Optional;

 public class UserService {
     public String getName(User user) {
@@ -10,3 +11,5 @@
     }
+
+    public void save(User user) {}
 }`;

describe("parseHunks", () => {
  it("extracts hunk positions from unified diff", () => {
    const hunks = parseHunks(SAMPLE_DIFF);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].newStart).toBe(1);
    expect(hunks[0].newCount).toBe(6);
    expect(hunks[0].changedLines).toEqual([2]);
    expect(hunks[1].newStart).toBe(11);
    expect(hunks[1].newCount).toBe(5);
    expect(hunks[1].changedLines).toEqual([12, 13]);
  });
});

describe("buildHybridContext", () => {
  const fileLines = [
    "package com.example;",
    "import java.util.Optional;",
    "",
    "public class UserService {",
    "    public String getName(User user) {",
    "        return user.getName();",
    "    }",
    "",
    "    public void save(User user) {",
    "        // TODO",
    "    }",
    "}",
  ];

  it("builds numbered context around hunks", () => {
    const hunks = [{ newStart: 5, newCount: 3, lines: [], changedLines: [6] }];
    const context = buildHybridContext(fileLines, hunks, 2);

    expect(context).toContain("3 ");
    expect(context).toContain("5 ");
    expect(context).toContain("7 ");
  });

  it("marks only added lines as changed", () => {
    const hunks = [{ newStart: 5, newCount: 3, lines: [], changedLines: [6] }];
    const context = buildHybridContext(fileLines, hunks, 2);

    expect(context).toContain("6 +        return user.getName();");
    expect(context).toContain("5      public String getName(User user) {");
  });

  it("merges overlapping context windows", () => {
    const hunks = [
      { newStart: 3, newCount: 2, lines: [], changedLines: [3] },
      { newStart: 5, newCount: 2, lines: [], changedLines: [5] },
    ];
    const context = buildHybridContext(fileLines, hunks, 2);
    const lineNumbers = context
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => parseInt(l.trim()));
    for (let i = 1; i < lineNumbers.length; i++) {
      expect(lineNumbers[i]).toBeGreaterThan(lineNumbers[i - 1]);
    }
  });

  it("respects max diff size limit", () => {
    const bigFile = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`);
    const hunks = [{
      newStart: 1,
      newCount: 2000,
      lines: [],
      changedLines: Array.from({ length: 2000 }, (_, i) => i + 1),
    }];
    const context = buildHybridContext(bigFile, hunks, 20, 1500);
    expect(context).toContain("too large");
  });
});
