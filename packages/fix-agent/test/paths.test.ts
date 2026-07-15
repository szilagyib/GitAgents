import { describe, it, expect } from "vitest";
import { resolveRepoDir, resolveRepoFilePath } from "../src/paths";

describe("resolveRepoDir", () => {
  it("prefers the explicit flag value", () => {
    expect(resolveRepoDir("/from/flag", "/from/env", "/from/cwd")).toBe(
      "/from/flag"
    );
  });

  it("falls back to env var when flag is missing", () => {
    expect(resolveRepoDir(undefined, "/from/env", "/from/cwd")).toBe(
      "/from/env"
    );
    expect(resolveRepoDir("", "/from/env", "/from/cwd")).toBe("/from/env");
  });

  it("falls back to cwd when neither flag nor env is set", () => {
    expect(resolveRepoDir(undefined, undefined, "/from/cwd")).toBe("/from/cwd");
    expect(resolveRepoDir("", "", "/from/cwd")).toBe("/from/cwd");
  });
});

describe("resolveRepoFilePath", () => {
  it("returns the absolute path unchanged", () => {
    const abs =
      process.platform === "win32" ? "C:\\foo\\bar.ts" : "/foo/bar.ts";
    expect(resolveRepoFilePath("/repo", abs)).toBe(abs);
  });

  it("resolves relative paths against the repo dir", () => {
    const got = resolveRepoFilePath("/repo", "src/App.ts");
    expect(got.endsWith("App.ts")).toBe(true);
    expect(got.includes("repo")).toBe(true);
  });
});
