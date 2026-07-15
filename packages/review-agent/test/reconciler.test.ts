import { describe, it, expect } from "vitest";
import {
  classifyFindings,
  buildPreviousMapFromThreads,
  buildUpdatedCommentMap,
  findingMarker,
} from "../src/reconciler";
import { computeFingerprint } from "@gitagents/core";
import type { CommentMap, FileReview, Finding, Thread } from "@gitagents/core";

const finding = (ruleId: string, line: number, codeContext = "code"): Finding => ({
  line,
  severity: "error",
  confidence: "high",
  ruleId,
  autoFixable: false,
  message: "msg",
  codeContext,
  suggestedApproach: "fix",
});

const fileReview = (path: string, findings: Finding[]): FileReview => ({
  path,
  language: "java",
  findings,
});

describe("classifyFindings", () => {
  it("classifies new findings", () => {
    const actions = classifyFindings(
      [fileReview("src/App.java", [finding("null-safety", 5)])],
      {},
      42
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("new");
    expect(actions[0].path).toBe("src/App.java");
  });

  it("classifies unchanged findings", () => {
    const fp = computeFingerprint(42, "null-safety", "src/App.java", "code");
    const previousMap: CommentMap = {
      [fp]: { threadId: "d1", noteId: "1", path: "src/App.java" },
    };

    const actions = classifyFindings(
      [fileReview("src/App.java", [finding("null-safety", 5)])],
      previousMap,
      42
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("unchanged");
  });

  it("treats a finding whose line drifted but whose code is identical as unchanged", () => {
    // Line-based fingerprints resolved + re-posted the same comment whenever an
    // unrelated edit shifted the file. Anchoring on code text keeps it stable.
    const fp = computeFingerprint(42, "null-safety", "src/App.java", "return x.y;");
    const previousMap: CommentMap = {
      [fp]: { threadId: "d1", noteId: "1", path: "src/App.java" },
    };

    const actions = classifyFindings(
      [fileReview("src/App.java", [finding("null-safety", 120, "return x.y;")])],
      previousMap,
      42
    );

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("unchanged");
    expect(actions.filter((a) => a.type === "fixed")).toHaveLength(0);
  });

  it("classifies fixed findings", () => {
    const previousMap: CommentMap = {
      somehash: { threadId: "d1", noteId: "1", path: "src/App.java" },
    };

    const actions = classifyFindings([], previousMap, 42);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("fixed");
  });

  it("does not mark another file's previous findings as fixed", () => {
    // previousMap contains a marker for file A; the current run only re-finds
    // file B's issue. File A's entry must NOT be reported fixed just because
    // this file's findings do not contain it.
    const fpA = computeFingerprint(42, "null-safety", "src/A.java", "code");
    const fpB = computeFingerprint(42, "null-safety", "src/B.java", "code");
    const previousMap: CommentMap = {
      [fpA]: { threadId: "a", noteId: "1", path: "src/A.java" },
      [fpB]: { threadId: "b", noteId: "2", path: "src/B.java" },
    };

    const actions = classifyFindings(
      [
        fileReview("src/A.java", [finding("null-safety", 1)]),
        fileReview("src/B.java", [finding("null-safety", 2)]),
      ],
      previousMap,
      42
    );

    expect(actions.filter((a) => a.type === "fixed")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "unchanged")).toHaveLength(2);
  });
});

describe("buildPreviousMapFromThreads", () => {
  it("reconstructs the map from finding markers in thread notes", () => {
    const threads: Thread[] = [
      {
        id: "thread-1",
        notes: [
          {
            id: "note-1",
            body: `Null deref here.\n\n${findingMarker("abc123", "src/App.java")}`,
            authorUsername: "bot",
          },
        ],
      },
      {
        id: "thread-2",
        notes: [{ id: "note-2", body: "just a human comment", authorUsername: "dev" }],
      },
    ];

    const map = buildPreviousMapFromThreads(threads);
    expect(map).toEqual({
      abc123: { threadId: "thread-1", noteId: "note-1", path: "src/App.java" },
    });
  });

  it("still reads markers written before path tracking existed", () => {
    const threads: Thread[] = [
      {
        id: "thread-1",
        notes: [
          { id: "note-1", body: "<!-- gitagents:finding:abc123 -->", authorUsername: "bot" },
        ],
      },
    ];

    const map = buildPreviousMapFromThreads(threads);
    expect(map.abc123).toEqual({ threadId: "thread-1", noteId: "note-1" });
  });

  it("lets a live thread marker win over the artifact fallback", () => {
    const threads: Thread[] = [
      {
        id: "live-thread",
        notes: [
          { id: "live-note", body: findingMarker("fp1", "src/A.java"), authorUsername: "bot" },
        ],
      },
    ];
    const fallback: CommentMap = {
      fp1: { threadId: "stale-thread", noteId: "stale-note", path: "src/A.java" },
      fp2: { threadId: "other-thread", noteId: "other-note", path: "src/B.java" },
    };

    const map = buildPreviousMapFromThreads(threads, fallback);
    expect(map.fp1).toEqual({
      threadId: "live-thread",
      noteId: "live-note",
      path: "src/A.java",
    });
    // Fallback-only entries survive.
    expect(map.fp2).toEqual({
      threadId: "other-thread",
      noteId: "other-note",
      path: "src/B.java",
    });
  });
});

describe("buildUpdatedCommentMap", () => {
  it("records the path of newly posted findings so the next run can protect them", () => {
    const actions = classifyFindings(
      [fileReview("src/App.java", [finding("null-safety", 5)])],
      {},
      42
    );
    const fp = actions[0].fingerprint;
    const map = buildUpdatedCommentMap(
      actions,
      new Map([[fp, { threadId: "t1", noteId: "n1" }]])
    );

    expect(map[fp]).toEqual({ threadId: "t1", noteId: "n1", path: "src/App.java" });
  });

  it("omits new findings that were never actually posted (inline cap overflow)", () => {
    const actions = classifyFindings(
      [fileReview("src/App.java", [finding("null-safety", 5)])],
      {},
      42
    );
    expect(buildUpdatedCommentMap(actions, new Map())).toEqual({});
  });
});
