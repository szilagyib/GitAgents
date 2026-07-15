import { describe, it, expect, vi, beforeEach } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFileSync: execFileSyncMock,
  execSync: vi.fn(() => {
    throw new Error(
      "git-ops must not use execSync — shell injection risk via untrusted commit message"
    );
  }),
}));

import { gitAddFiles, gitCommit, gitPush } from "../src/git-ops";

describe("git-ops", () => {
  beforeEach(() => {
    execFileSyncMock.mockClear();
  });

  it("gitAddFiles stages only explicit fixed files without a shell", () => {
    gitAddFiles("/tmp/repo", ["src/A.java", "src/B.java"]);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execFileSyncMock.mock.calls[0]!;
    expect(cmd).toBe("git");
    expect(args).toEqual(["add", "--", "src/A.java", "src/B.java"]);
    expect(opts).toMatchObject({ cwd: "/tmp/repo" });
  });

  it("gitAddFiles does nothing when no files changed", () => {
    gitAddFiles("/tmp/repo", []);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("gitCommit passes the message as a separate argv element, not concatenated", () => {
    const malicious = '"; rm -rf / #';
    gitCommit("/tmp/repo", malicious);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileSyncMock.mock.calls[0]!;
    expect(cmd).toBe("git");
    expect(args).toEqual(["commit", "-m", malicious]);
  });

  it("gitPush first clears any inherited http.extraHeader so runner-injected auth doesn't shadow ours", () => {
    gitPush(
      "/tmp/repo",
      "https://gitlab.example.com/group/project.git",
      "feature-branch",
      "glpat-abc123"
    );
    const unsetCall = execFileSyncMock.mock.calls.find(
      (call) =>
        Array.isArray(call[1]) &&
        call[1].includes("--unset-all") &&
        call[1].includes("http.extraHeader")
    );
    expect(unsetCall).toBeDefined();
    expect(unsetCall![0]).toBe("git");
    expect(unsetCall![1]).toEqual([
      "config",
      "--local",
      "--unset-all",
      "http.extraHeader",
    ]);
  });

  it("gitPush survives when there is no extraHeader to unset", () => {
    execFileSyncMock.mockImplementationOnce(() => {
      const err: Error & { status?: number } = new Error("nothing to unset");
      err.status = 5;
      throw err;
    });
    expect(() =>
      gitPush(
        "/tmp/repo",
        "https://gitlab.example.com/group/project.git",
        "feature-branch",
        "glpat-abc123"
      )
    ).not.toThrow();
  });

  it("gitPush passes the PAT only via env, not via any command-line argument", () => {
    gitPush(
      "/tmp/repo",
      "https://gitlab.example.com/group/project.git",
      "feature-branch",
      "glpat-abc123"
    );
    const pushCall = execFileSyncMock.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1].includes("push")
    );
    expect(pushCall).toBeDefined();
    for (const arg of pushCall![1]) {
      expect(arg).not.toContain("glpat-abc123");
    }
    const env = (pushCall![2] as { env?: Record<string, string> } | undefined)?.env;
    expect(env).toBeDefined();
    expect(env!["GITAGENTS_PUSH_TOKEN"]).toBe("glpat-abc123");
  });

  it("gitPush wires a credential helper that reads the token from the env var", () => {
    gitPush(
      "/tmp/repo",
      "https://gitlab.example.com/group/project.git",
      "feature-branch",
      "glpat-abc123"
    );
    const pushCall = execFileSyncMock.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1].includes("push")
    )!;
    const helperIdx = pushCall[1].findIndex(
      (arg: string) => typeof arg === "string" && arg.startsWith("credential.helper=")
    );
    expect(helperIdx).toBeGreaterThan(-1);
    const helper = pushCall[1][helperIdx];
    expect(helper).toContain("username=oauth2");
    expect(helper).toContain("$GITAGENTS_PUSH_TOKEN");
  });

  it("gitPush does not embed the token in the push URL", () => {
    gitPush(
      "/tmp/repo",
      "https://gitlab.example.com/group/project.git",
      "feature-branch",
      "glpat-abc123"
    );
    const pushCall = execFileSyncMock.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1].includes("push")
    )!;
    const url = pushCall[1].find((a: string) => a.startsWith("https://"));
    expect(url).toBeDefined();
    expect(url).not.toContain("glpat-abc123");
    expect(url).not.toContain("oauth2:");
  });
});
