import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { REPO_TOOLS, createRepoToolExecutor } from "../src/repo-tools";

let repoDir: string;

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), "gitagents-tools-"));
  mkdirSync(join(repoDir, "src"), { recursive: true });
  mkdirSync(join(repoDir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(
    join(repoDir, "src", "App.java"),
    ["class App {", "  void run() {", "    helper();", "  }", "}"].join("\n")
  );
  writeFileSync(
    join(repoDir, "src", "Helper.java"),
    ["class Helper {", "  static void helper() {}", "}"].join("\n")
  );
  writeFileSync(join(repoDir, "node_modules", "pkg", "index.js"), "helper();");
  writeFileSync(join(repoDir, "secret.txt"), "should not be searched");
});

afterAll(() => rmSync(repoDir, { recursive: true, force: true }));

describe("REPO_TOOLS", () => {
  it("exposes only read-only tools", () => {
    // Gate decisions and comment posting stay in code; a write tool here would
    // hand the model back the authority this design deliberately removed.
    expect(REPO_TOOLS.map((t) => t.name).sort()).toEqual(["read_file", "search_repo"]);
  });
});

describe("createRepoToolExecutor", () => {
  it("returns null when the checkout does not exist", () => {
    expect(createRepoToolExecutor(join(repoDir, "nope"))).toBeNull();
  });

  it("reads a file as numbered lines", async () => {
    const execute = createRepoToolExecutor(repoDir)!;
    const out = await execute("read_file", { path: "src/Helper.java" });
    expect(out).toContain("1: class Helper {");
    expect(out).toContain("2:   static void helper() {}");
  });

  it("honours a line range", async () => {
    const execute = createRepoToolExecutor(repoDir)!;
    const out = await execute("read_file", { path: "src/App.java", startLine: 2, endLine: 3 });
    expect(out).toContain("2:   void run() {");
    expect(out).toContain("3:     helper();");
    expect(out).not.toContain("1: class App {");
  });

  it("reports a missing file instead of throwing", async () => {
    const execute = createRepoToolExecutor(repoDir)!;
    expect(await execute("read_file", { path: "src/Ghost.java" })).toContain("File not found");
  });

  it("refuses to escape the repository root", async () => {
    const execute = createRepoToolExecutor(repoDir)!;
    await expect(execute("read_file", { path: "../../../etc/passwd" })).rejects.toThrow(
      /outside the repository/
    );
  });

  it("searches the repo and reports path:line matches", async () => {
    const execute = createRepoToolExecutor(repoDir)!;
    const out = await execute("search_repo", { query: "helper()" });
    expect(out).toContain("src/App.java:3");
    expect(out).toContain("src/Helper.java:2");
  });

  it("skips node_modules when searching", async () => {
    const execute = createRepoToolExecutor(repoDir)!;
    const out = await execute("search_repo", { query: "helper()" });
    expect(out).not.toContain("node_modules");
  });

  it("reports no matches without failing", async () => {
    const execute = createRepoToolExecutor(repoDir)!;
    expect(await execute("search_repo", { query: "nonexistentSymbol" })).toContain("No matches");
  });

  it("rejects an unknown tool name", async () => {
    const execute = createRepoToolExecutor(repoDir)!;
    expect(await execute("post_comment", { body: "x" })).toContain("unknown tool");
  });
});
