export type DiffLineKind = "added" | "context";

export interface DiffLineInfo {
  kind: DiffLineKind;
  oldLine?: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseDiffHunks(diff: string): Map<number, DiffLineInfo> {
  const map = new Map<number, DiffLineInfo>();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const raw of diff.split("\n")) {
    const header = raw.match(HUNK_HEADER);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    const marker = raw.charAt(0);
    if (marker === "+") {
      map.set(newLine, { kind: "added" });
      newLine++;
    } else if (marker === "-") {
      oldLine++;
    } else if (marker === " ") {
      map.set(newLine, { kind: "context", oldLine });
      oldLine++;
      newLine++;
    }
  }

  return map;
}
