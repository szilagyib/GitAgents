export interface PatchApplyResult {
  valid: boolean;
  content?: string;
  reason?: string;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  lines: string[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function applyUnifiedDiff(
  originalContent: string,
  patch: string,
  expectedFilePath: string
): PatchApplyResult {
  const trimmedPatch = patch.trim();
  if (!trimmedPatch || trimmedPatch === "NO_SAFE_FIX") {
    return { valid: false, reason: "no safe patch returned" };
  }

  const lines = trimmedPatch.replace(/\r\n/g, "\n").split("\n");
  const pathCheck = validatePatchPath(lines, expectedFilePath);
  if (!pathCheck.valid) return pathCheck;

  const hunks = parseHunks(lines);
  if (!hunks.valid || !hunks.hunks) {
    return { valid: false, reason: hunks.reason };
  }

  const original = splitContent(originalContent);
  const applied = applyHunks(original.lines, hunks.hunks);
  if (!applied.valid || !applied.lines) {
    return { valid: false, reason: applied.reason };
  }

  const content = joinContent(
    applied.lines,
    original.hasFinalNewline,
    original.lineEnding
  );
  if (content === originalContent) {
    return { valid: false, reason: "patch made no changes" };
  }

  return { valid: true, content };
}

function validatePatchPath(lines: string[], expectedFilePath: string): PatchApplyResult {
  const newPaths: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i - 1].startsWith("--- ") && lines[i].startsWith("+++ ")) {
      newPaths.push(normalizePatchPath(lines[i].slice(4).trim()));
    }
  }

  if (newPaths.length === 0) {
    return { valid: false, reason: "patch is missing +++ file header" };
  }

  if (newPaths.length > 1) {
    return { valid: false, reason: "patch modifies multiple files" };
  }

  const expected = normalizePatchPath(expectedFilePath);
  if (newPaths[0] !== expected) {
    return {
      valid: false,
      reason: `patch targets ${newPaths[0]}, expected ${expected}`,
    };
  }

  return { valid: true };
}

function normalizePatchPath(path: string): string {
  const cleaned = path.replace(/\\/g, "/").replace(/^"|"$/g, "");
  if (cleaned === "/dev/null") return cleaned;
  return cleaned.replace(/^[ab]\//, "");
}

function parseHunks(lines: string[]): { valid: boolean; hunks?: Hunk[]; reason?: string } {
  const hunks: Hunk[] = [];
  let i = 0;

  while (i < lines.length) {
    const header = lines[i].match(HUNK_HEADER);
    if (!header) {
      i++;
      continue;
    }

    const hunk: Hunk = {
      oldStart: Number(header[1]),
      oldCount: Number(header[2] ?? "1"),
      lines: [],
    };
    i++;

    while (i < lines.length && !HUNK_HEADER.test(lines[i])) {
      const line = lines[i];
      if (line.startsWith("diff --git ")) {
        return { valid: false, reason: "patch contains multiple file sections" };
      }
      if (
        line.startsWith(" ") ||
        line.startsWith("-") ||
        line.startsWith("+") ||
        line.startsWith("\\")
      ) {
        hunk.lines.push(line);
        i++;
        continue;
      }
      return { valid: false, reason: `invalid patch line: ${line}` };
    }

    hunks.push(hunk);
  }

  if (hunks.length === 0) {
    return { valid: false, reason: "patch contains no hunks" };
  }

  return { valid: true, hunks };
}

function applyHunks(
  originalLines: string[],
  hunks: Hunk[]
): { valid: boolean; lines?: string[]; reason?: string } {
  const output: string[] = [];
  let originalIndex = 0;

  for (const hunk of hunks) {
    const hunkStart = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (hunkStart < originalIndex || hunkStart > originalLines.length) {
      return { valid: false, reason: "patch hunks are out of order" };
    }

    output.push(...originalLines.slice(originalIndex, hunkStart));
    let hunkOriginalIndex = hunkStart;

    for (const line of hunk.lines) {
      if (line.startsWith("\\")) continue;

      const kind = line[0];
      const text = line.slice(1);

      if (kind === " ") {
        if (originalLines[hunkOriginalIndex] !== text) {
          return {
            valid: false,
            reason: `patch context mismatch near line ${hunkOriginalIndex + 1}`,
          };
        }
        output.push(text);
        hunkOriginalIndex++;
      } else if (kind === "-") {
        if (originalLines[hunkOriginalIndex] !== text) {
          return {
            valid: false,
            reason: `patch removal mismatch near line ${hunkOriginalIndex + 1}`,
          };
        }
        hunkOriginalIndex++;
      } else if (kind === "+") {
        output.push(text);
      } else {
        return { valid: false, reason: `invalid patch line: ${line}` };
      }
    }

    originalIndex = hunkOriginalIndex;
  }

  output.push(...originalLines.slice(originalIndex));
  return { valid: true, lines: output };
}

export interface SplitContent {
  lines: string[];
  hasFinalNewline: boolean;
  lineEnding: string;
}

// EOL-aware line split. Lines are returned LF-clean (any \r\n is normalized
// away), while the original line ending and trailing-newline state are
// preserved so joinContent can reconstruct the file byte-for-byte.
export function splitContent(content: string): SplitContent {
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.replace(/\r\n/g, "\n");
  const hasFinalNewline = normalized.endsWith("\n");
  const body = hasFinalNewline ? normalized.slice(0, -1) : normalized;
  return {
    lines: body === "" ? [] : body.split("\n"),
    hasFinalNewline,
    lineEnding,
  };
}

export function joinContent(
  lines: string[],
  hasFinalNewline: boolean,
  lineEnding: string
): string {
  return `${lines.join(lineEnding)}${hasFinalNewline ? lineEnding : ""}`;
}
