import {
  type Finding,
} from "@gitagents/core";
import {
  isTransientForgeError,
  type RepoRef,
} from "@gitagents/forge";
import path from "path";

export interface FileContentReader {
  getFileContent(repo: RepoRef, filePath: string, ref: string): Promise<string>;
}

export interface MissingFileCheckInput {
  filePath: string;
  fileLines: string[];
  changedLines: number[];
  repo: RepoRef;
  ref: string;
  reader: FileContentReader;
}

interface Reference {
  line: number;
  specifier: string;
  codeContext: string;
}

const JS_TS_FILE = /\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)$/;
const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

const MODULE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".json",
];

// NodeNext resolves a `./x.js` specifier to its TypeScript sibling `x.ts`. A
// literal-path check would flag the standard ESM idiom as a missing file, so map
// each JS-family extension to the TS siblings that legitimately satisfy it.
const JS_TO_TS_SIBLINGS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx", ".ts"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

type CandidateStatus = "exists" | "missing" | "transient";

export async function detectMissingFileReferences(
  input: MissingFileCheckInput
): Promise<Finding[]> {
  if (!JS_TS_FILE.test(input.filePath)) return [];

  const references = extractReferences(
    input.filePath,
    input.fileLines,
    input.changedLines
  );
  if (references.length === 0) return [];

  const statusCache = new Map<string, Promise<CandidateStatus>>();
  const findings: Finding[] = [];

  for (const reference of references) {
    const candidates = buildCandidatePaths(input.filePath, reference.specifier);
    const resolves = await referenceResolves(candidates, input, statusCache);
    if (resolves) continue;

    findings.push({
      line: reference.line,
      severity: "error",
      confidence: "medium",
      ruleId: "missing-file-reference",
      autoFixable: false,
      fixStrategy: "manual-only",
      fixabilityReason: "The referenced file is absent from the source branch and must be committed or the import changed.",
      message: `Relative import \`${reference.specifier}\` does not resolve to a committed file on the source branch.`,
      codeContext: reference.codeContext,
      suggestedApproach: "Commit the missing file or update the import path to an existing module.",
    });
  }

  return findings;
}

function extractReferences(
  filePath: string,
  fileLines: string[],
  changedLines: number[]
): Reference[] {
  const references: Reference[] = [];

  for (const lineNumber of changedLines) {
    const line = fileLines[lineNumber - 1] ?? "";
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const specifier = normalizeSpecifier(match[1]);
        if (!specifier || !isRelativeModuleSpecifier(specifier)) continue;
        references.push({
          line: lineNumber,
          specifier,
          codeContext: line.trim(),
        });
      }
    }
  }

  return dedupeReferences(references);
}

function normalizeSpecifier(specifier: string): string {
  return specifier.split(/[?#]/, 1)[0].replace(/\\/g, "/");
}

function isRelativeModuleSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function buildCandidatePaths(filePath: string, specifier: string): string[] {
  const base = normalizeRepoPath(
    path.posix.join(path.posix.dirname(filePath), specifier)
  );
  const extension = path.posix.extname(base);

  if (extension) {
    const siblings = JS_TO_TS_SIBLINGS[extension] ?? [];
    if (siblings.length === 0) return [base];
    const withoutExtension = base.slice(0, base.length - extension.length);
    return [base, ...siblings.map((ext) => `${withoutExtension}${ext}`)];
  }

  return [
    base,
    ...MODULE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...MODULE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ];
}

function normalizeRepoPath(candidate: string): string {
  return candidate.replace(/\\/g, "/").replace(/^\.\//, "");
}

async function referenceResolves(
  candidates: string[],
  input: MissingFileCheckInput,
  statusCache: Map<string, Promise<CandidateStatus>>
): Promise<boolean> {
  let sawTransient = false;
  for (const candidate of candidates) {
    if (!statusCache.has(candidate)) {
      statusCache.set(candidate, candidateStatus(input.reader, input.repo, candidate, input.ref));
    }
    const status = await statusCache.get(candidate)!;
    if (status === "exists") return true;
    if (status === "transient") sawTransient = true;
  }
  // A transient forge error (429/5xx/network) is not proof the file is missing.
  // Treat it as resolved so a flaky lookup never turns into a false finding.
  return sawTransient;
}

async function candidateStatus(
  reader: FileContentReader,
  repo: RepoRef,
  filePath: string,
  ref: string
): Promise<CandidateStatus> {
  try {
    await reader.getFileContent(repo, filePath, ref);
    return "exists";
  } catch (error: unknown) {
    return isTransientForgeError(error) ? "transient" : "missing";
  }
}

function dedupeReferences(references: Reference[]): Reference[] {
  const seen = new Set<string>();
  const deduped: Reference[] = [];
  for (const reference of references) {
    const key = `${reference.line}:${reference.specifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(reference);
  }
  return deduped;
}
