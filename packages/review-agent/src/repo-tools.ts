import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative, resolve, sep } from "path";
import type { LlmToolSpec, LlmToolExecutor } from "@gitagents/core";

/**
 * Read-only evidence tools for the verification pass, served from the repo
 * checkout the CI job already has on disk — so they cost no API calls and no
 * tokens beyond the text the model asks for.
 *
 * Read-only is a hard boundary, not an oversight. Gate decisions, comment
 * posting and fix application stay in deterministic code; the model gets
 * evidence, never side effects.
 */

const MAX_FILE_LINES = 400;
const MAX_SEARCH_RESULTS = 40;
const MAX_SEARCHED_FILES = 4000;
const MAX_SEARCHABLE_BYTES = 512 * 1024;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  ".venv",
  "__pycache__",
  ".gradle",
  ".idea",
]);

const TEXT_FILE = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|java|kt|kts|js|jsx|mjs|cjs|ts|tsx|mts|cts|py|rb|go|rs|cs|php|scala|swift|sql|sh|bash|yml|yaml|json|xml|gradle|properties|toml|ini|cfg|md|txt)$/i;

export const REPO_TOOLS: LlmToolSpec[] = [
  {
    name: "read_file",
    description:
      "Read a text file from the repository under review, at the revision being reviewed. " +
      "Use it to check a definition, a caller, or a guard that the diff does not show. " +
      "Returns 1-indexed numbered lines.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Repository-relative path, e.g. src/main/java/App.java",
        },
        startLine: {
          type: "integer",
          description: "First line to return (1-indexed). Defaults to 1.",
        },
        endLine: {
          type: "integer",
          description: `Last line to return (inclusive). At most ${MAX_FILE_LINES} lines are returned.`,
        },
      },
      required: ["path"],
    },
  },
  {
    name: "search_repo",
    description:
      "Search the repository for a literal string (for example a symbol, function or constant name). " +
      "Use it to find where something is defined, called, or validated before ruling on a finding.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Literal text to search for." },
        maxResults: {
          type: "integer",
          description: `Maximum matches to return (default and cap ${MAX_SEARCH_RESULTS}).`,
        },
      },
      required: ["query"],
    },
  },
];

/** Resolves a repo-relative path, rejecting traversal outside the repo root. */
function safeResolve(repoDir: string, path: string): string {
  const root = resolve(repoDir);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || resolve(rel) === rel) {
    throw new Error(`path ${path} is outside the repository`);
  }
  return target;
}

function readFileTool(repoDir: string, input: Record<string, unknown>): string {
  const path = String(input.path ?? "");
  if (!path) return "ERROR: path is required.";

  const target = safeResolve(repoDir, path);
  if (!existsSync(target) || !statSync(target).isFile()) {
    return `File not found: ${path}`;
  }

  const lines = readFileSync(target, "utf-8").split(/\r?\n/);
  const start = Math.max(1, Number(input.startLine ?? 1) || 1);
  const requestedEnd = Number(input.endLine ?? start + MAX_FILE_LINES - 1) || lines.length;
  const end = Math.min(lines.length, requestedEnd, start + MAX_FILE_LINES - 1);

  if (start > lines.length) {
    return `File ${path} has only ${lines.length} lines.`;
  }

  const body = lines
    .slice(start - 1, end)
    .map((line, i) => `${start + i}: ${line}`)
    .join("\n");
  const truncated =
    end < lines.length ? `\n... (${lines.length - end} more lines not shown)` : "";
  return `${path} (lines ${start}-${end} of ${lines.length}):\n${body}${truncated}`;
}

function* walk(dir: string, budget: { files: number }): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.files <= 0) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full, budget);
    } else if (entry.isFile() && TEXT_FILE.test(entry.name)) {
      budget.files--;
      yield full;
    }
  }
}

function searchRepoTool(repoDir: string, input: Record<string, unknown>): string {
  const query = String(input.query ?? "");
  if (!query) return "ERROR: query is required.";

  const limit = Math.min(
    MAX_SEARCH_RESULTS,
    Math.max(1, Number(input.maxResults ?? MAX_SEARCH_RESULTS) || MAX_SEARCH_RESULTS)
  );
  const root = resolve(repoDir);
  const matches: string[] = [];

  for (const file of walk(root, { files: MAX_SEARCHED_FILES })) {
    if (matches.length >= limit) break;
    let content: string;
    try {
      if (statSync(file).size > MAX_SEARCHABLE_BYTES) continue;
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (!content.includes(query)) continue;

    const relPath = relative(root, file).split(sep).join("/");
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length && matches.length < limit; i++) {
      if (lines[i].includes(query)) {
        matches.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }

  if (matches.length === 0) return `No matches for "${query}".`;
  return `${matches.length} match(es) for "${query}":\n${matches.join("\n")}`;
}

/**
 * Builds the tool executor bound to a repo checkout. Returns null when the
 * directory is not a usable checkout, so the caller simply verifies without
 * tools instead of failing.
 */
export function createRepoToolExecutor(repoDir: string): LlmToolExecutor | null {
  if (!repoDir || !existsSync(repoDir)) return null;

  return async (name, input) => {
    switch (name) {
      case "read_file":
        return readFileTool(repoDir, input);
      case "search_repo":
        return searchRepoTool(repoDir, input);
      default:
        return `ERROR: unknown tool "${name}".`;
    }
  };
}
