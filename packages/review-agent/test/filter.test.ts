import { describe, it, expect } from "vitest";
import { shouldSkipFile } from "../src/filter";
import type { FileDiff } from "@gitagents/core";

describe("shouldSkipFile", () => {
  const xcoreChanged = true;
  const xcoreNotChanged = false;

  it("skips files in src-gen/ directories", () => {
    expect(shouldSkipFile("model/src-gen/Generated.java", xcoreNotChanged)).toBe(true);
  });

  it("skips deleted files", () => {
    const diff: FileDiff = {
      oldPath: "src/Old.java",
      newPath: "src/Old.java",
      diff: "",
      newFile: false,
      renamedFile: false,
      deletedFile: true,
    };
    expect(shouldSkipFile(diff.newPath, xcoreNotChanged, diff)).toBe(true);
  });

  it("skips src/ and src-gen/ when xcore files changed", () => {
    expect(shouldSkipFile("model/src/ModelImpl.java", xcoreChanged)).toBe(true);
    expect(shouldSkipFile("model/src-gen/ModelPackage.java", xcoreChanged)).toBe(true);
  });

  it("does NOT skip the xcore file itself", () => {
    expect(shouldSkipFile("model/model.xcore", xcoreChanged)).toBe(false);
  });

  it("does NOT skip normal source files when xcore not changed", () => {
    expect(shouldSkipFile("src/main/java/App.java", xcoreNotChanged)).toBe(false);
  });

  it("skips files with generated header content", () => {
    expect(shouldSkipFile("src/Gen.java", xcoreNotChanged, undefined, "// @generated")).toBe(true);
    expect(shouldSkipFile("src/Gen.java", xcoreNotChanged, undefined, "/* DO NOT EDIT */")).toBe(true);
  });

  it("skips package lock files", () => {
    expect(shouldSkipFile("package-lock.json", xcoreNotChanged)).toBe(true);
    expect(shouldSkipFile("frontend/package-lock.json", xcoreNotChanged)).toBe(true);
    expect(shouldSkipFile("yarn.lock", xcoreNotChanged)).toBe(true);
    expect(shouldSkipFile("pnpm-lock.yaml", xcoreNotChanged)).toBe(true);
    expect(shouldSkipFile("npm-shrinkwrap.json", xcoreNotChanged)).toBe(true);
    expect(shouldSkipFile("backend/poetry.lock", xcoreNotChanged)).toBe(true);
    expect(shouldSkipFile("Pipfile.lock", xcoreNotChanged)).toBe(true);
    expect(shouldSkipFile("Cargo.lock", xcoreNotChanged)).toBe(true);
    expect(shouldSkipFile("Gemfile.lock", xcoreNotChanged)).toBe(true);
    expect(shouldSkipFile("composer.lock", xcoreNotChanged)).toBe(true);
    expect(shouldSkipFile("go.sum", xcoreNotChanged)).toBe(true);
  });

  it("does NOT skip package.json or other manifest files", () => {
    expect(shouldSkipFile("package.json", xcoreNotChanged)).toBe(false);
    expect(shouldSkipFile("Cargo.toml", xcoreNotChanged)).toBe(false);
    expect(shouldSkipFile("go.mod", xcoreNotChanged)).toBe(false);
  });
});
