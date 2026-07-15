import { describe, expect, it } from "vitest";
import { detectMissingFileReferences, type FileContentReader } from "../src/missing-files";
import type { RepoRef } from "@gitagents/core";

const repo: RepoRef = { forge: "gitlab", projectId: 1, slug: "g/p" };

function readerWithFiles(files: string[]): FileContentReader {
  const existing = new Set(files);
  return {
    async getFileContent(_repo: RepoRef, filePath: string): Promise<string> {
      if (!existing.has(filePath)) throw new Error("missing");
      return "ok";
    },
  };
}

describe("detectMissingFileReferences", () => {
  it("flags changed relative imports that do not resolve to a committed file", async () => {
    const findings = await detectMissingFileReferences({
      filePath: "src/pages/App.tsx",
      fileLines: ["import Widget from '../components/Widget';"],
      changedLines: [1],
      repo,
      ref: "feature",
      reader: readerWithFiles([]),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe("missing-file-reference");
    expect(findings[0].line).toBe(1);
  });

  it("emits a heuristic (medium confidence), neutral-toned finding", async () => {
    const findings = await detectMissingFileReferences({
      filePath: "src/pages/App.tsx",
      fileLines: ["import Widget from '../components/Widget';"],
      changedLines: [1],
      repo,
      ref: "feature",
      reader: readerWithFiles([]),
    });

    expect(findings[0].confidence).toBe("medium");
    expect(findings[0].message).not.toMatch(/Forgot to add it/i);
  });

  it("accepts the NodeNext `./x.js` idiom when only the TS sibling exists", async () => {
    const findings = await detectMissingFileReferences({
      filePath: "src/orchestrator.ts",
      fileLines: ["import { filter } from './filter.js';"],
      changedLines: [1],
      repo,
      ref: "feature",
      reader: readerWithFiles(["src/filter.ts"]),
    });

    expect(findings).toHaveLength(0);
  });

  it("does not flag a reference when the lookup fails with a transient forge error", async () => {
    const transientReader: FileContentReader = {
      async getFileContent(): Promise<string> {
        throw Object.assign(new Error("Service Unavailable"), { status: 503 });
      },
    };

    const findings = await detectMissingFileReferences({
      filePath: "src/pages/App.tsx",
      fileLines: ["import Widget from '../components/Widget';"],
      changedLines: [1],
      repo,
      ref: "feature",
      reader: transientReader,
    });

    expect(findings).toHaveLength(0);
  });

  it("accepts extensionless imports when a candidate file exists", async () => {
    const findings = await detectMissingFileReferences({
      filePath: "src/pages/App.tsx",
      fileLines: ["import Widget from '../components/Widget';"],
      changedLines: [1],
      repo,
      ref: "feature",
      reader: readerWithFiles(["src/components/Widget.tsx"]),
    });

    expect(findings).toHaveLength(0);
  });

  it("accepts directory imports when an index candidate exists", async () => {
    const findings = await detectMissingFileReferences({
      filePath: "src/pages/App.tsx",
      fileLines: ["const Widget = require('../components/Widget');"],
      changedLines: [1],
      repo,
      ref: "feature",
      reader: readerWithFiles(["src/components/Widget/index.ts"]),
    });

    expect(findings).toHaveLength(0);
  });

  it("ignores package imports and unchanged lines", async () => {
    const findings = await detectMissingFileReferences({
      filePath: "src/pages/App.tsx",
      fileLines: [
        "import React from 'react';",
        "import Missing from '../components/Missing';",
      ],
      changedLines: [1],
      repo,
      ref: "feature",
      reader: readerWithFiles([]),
    });

    expect(findings).toHaveLength(0);
  });
});
