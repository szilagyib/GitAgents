export interface Hunk {
  newStart: number;
  newCount: number;
  lines: string[];
  changedLines: number[];
}

export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  const hunkHeaderRegex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let match: RegExpExecArray | null;

  while ((match = hunkHeaderRegex.exec(diff)) !== null) {
    const newStart = parseInt(match[1], 10);
    const newCount = match[2] ? parseInt(match[2], 10) : 1;

    // Extract lines belonging to this hunk (until next @@ or end)
    const afterHeader = diff.slice(match.index + match[0].length);
    const nextHunk = afterHeader.indexOf("\n@@");
    const hunkBody =
      nextHunk >= 0 ? afterHeader.slice(0, nextHunk) : afterHeader;
    const lines = hunkBody.split("\n").filter((l) => l !== "");
    const changedLines: number[] = [];
    let newLine = newStart;
    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        changedLines.push(newLine);
        newLine++;
      } else if (line.startsWith(" ") || line === "") {
        newLine++;
      }
    }

    hunks.push({ newStart, newCount, lines, changedLines });
  }

  return hunks;
}

interface ContextWindow {
  start: number; // 1-based line number
  end: number; // 1-based line number (inclusive)
}

function mergeWindows(windows: ContextWindow[]): ContextWindow[] {
  if (windows.length === 0) return [];

  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const merged: ContextWindow[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];

    if (curr.start <= prev.end + 1) {
      prev.end = Math.max(prev.end, curr.end);
    } else {
      merged.push(curr);
    }
  }

  return merged;
}

export function buildHybridContext(
  fileLines: string[],
  hunks: Hunk[],
  contextSize: number = 20,
  maxDiffLines: number = 1500
): string {
  const totalLines = fileLines.length;

  // Check diff size limit
  const totalHunkLines = hunks.reduce((sum, h) => sum + h.changedLines.length, 0);
  if (totalHunkLines > maxDiffLines) {
    return `[FILE TOO LARGE: ${totalHunkLines} lines changed, max is ${maxDiffLines}. File is too large for automated review, please review manually.]`;
  }

  // Build context windows around each hunk
  const windows: ContextWindow[] = hunks.map((h) => ({
    start: Math.max(1, h.newStart - contextSize),
    end: Math.min(totalLines, h.newStart + h.newCount - 1 + contextSize),
  }));

  const mergedWindows = mergeWindows(windows);

  // Build the changed line set (lines that are new/modified)
  const changedLines = new Set<number>();
  for (const hunk of hunks) {
    for (const line of hunk.changedLines) changedLines.add(line);
  }

  // Build output with line numbers
  const parts: string[] = [];
  for (const window of mergedWindows) {
    if (parts.length > 0) parts.push("...");

    for (let i = window.start; i <= window.end; i++) {
      const lineContent = fileLines[i - 1] ?? "";
      const marker = changedLines.has(i) ? "+" : " ";
      const lineNum = String(i).padStart(String(totalLines).length);
      parts.push(`${lineNum} ${marker}${lineContent}`);
    }
  }

  return parts.join("\n");
}

export function getChangedLines(hunks: Hunk[]): number[] {
  return [...new Set(hunks.flatMap((hunk) => hunk.changedLines))].sort(
    (a, b) => a - b
  );
}
