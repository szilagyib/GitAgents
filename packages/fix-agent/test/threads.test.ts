import { describe, it, expect, vi } from "vitest";
import {
  type CommentMap,
} from "@gitagents/core";
import {
  type Forge,
  type RepoRef,
} from "@gitagents/forge";
import { resolveFixedThreads } from "../src/threads";
import type { FindingRef } from "../src/summary";

function makeForge() {
  return {
    addReply: vi.fn().mockResolvedValue(undefined),
    resolveThread: vi.fn().mockResolvedValue(undefined),
  } as unknown as Forge;
}

const mrId = 42;
const repo: RepoRef = { forge: "gitlab", projectId: 1, slug: "g/p" };

function ref(path: string, line: number, ruleId: string): FindingRef {
  return { path, line, ruleId, message: "fixed" };
}

function applied(r: FindingRef, fingerprint: string) {
  return { ref: r, fingerprint };
}

describe("resolveFixedThreads", () => {
  it("resolves and replies on each thread that maps to an applied finding", async () => {
    const r = ref("src/A.java", 10, "null-safety");
    const commentMap: CommentMap = { fp1: { threadId: "disc-1", noteId: "100" } };
    const forge = makeForge();

    const summary = await resolveFixedThreads(forge, repo, mrId, [applied(r, "fp1")], commentMap);

    expect(summary.resolvedCount).toBe(1);
    expect(summary.failed).toEqual([]);
    expect((forge as any).addReply).toHaveBeenCalledWith(
      repo, mrId, "disc-1", "100",
      expect.stringContaining("src/A.java:10")
    );
    expect((forge as any).resolveThread).toHaveBeenCalledWith(repo, mrId, "disc-1", true);
  });

  it("skips applied findings without a discussion entry (no inline ever posted)", async () => {
    const r = ref("src/A.java", 10, "null-safety");
    const forge = makeForge();

    const summary = await resolveFixedThreads(forge, repo, mrId, [applied(r, "fp1")], {});

    expect(summary.resolvedCount).toBe(0);
    expect(summary.failed).toEqual([]);
    expect((forge as any).resolveThread).not.toHaveBeenCalled();
  });

  it("collects failures and keeps going on subsequent findings", async () => {
    const r1 = ref("src/A.java", 10, "rule-a");
    const r2 = ref("src/B.java", 20, "rule-b");
    const commentMap: CommentMap = {
      fp1: { threadId: "disc-1", noteId: "100" },
      fp2: { threadId: "disc-2", noteId: "200" },
    };
    const forge = makeForge();
    (forge as any).resolveThread
      .mockRejectedValueOnce(new Error("500"))
      .mockResolvedValueOnce(undefined);

    const summary = await resolveFixedThreads(
      forge,
      repo,
      mrId,
      [applied(r1, "fp1"), applied(r2, "fp2")],
      commentMap
    );

    expect(summary.resolvedCount).toBe(1);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0].ref).toBe(r1);
    expect((forge as any).resolveThread).toHaveBeenCalledTimes(2);
  });
});
