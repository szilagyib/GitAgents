import type { Finding } from "@gitagents/core";
import { validateFix } from "./validator.js";
import { splitContent, joinContent, type SplitContent } from "./patch.js";
import type { FixResult } from "./types.js";

export function tryDeterministicFix(
  filePath: string,
  fileContent: string,
  finding: Finding
): FixResult | null {
  const fixedContent = applyDeterministicEdit(fileContent, finding);
  if (fixedContent === null) return null;

  if (fixedContent === fileContent) {
    return {
      finding,
      filePath,
      fixedContent: fileContent,
      applied: false,
      skipReason: "deterministic fix made no changes",
    };
  }

  const validation = validateFix(fileContent, fixedContent, finding.line);
  if (!validation.valid) {
    return {
      finding,
      filePath,
      fixedContent: fileContent,
      applied: false,
      skipReason: validation.reason,
    };
  }

  return {
    finding,
    filePath,
    fixedContent,
    applied: true,
  };
}

function applyDeterministicEdit(
  fileContent: string,
  finding: Finding
): string | null {
  switch (finding.fixStrategy) {
    case "remove-focused-test":
      return replaceLine(fileContent, finding.line, (line) =>
        line.replace(/\b(describe|it|test)\.only\s*\(/, "$1(")
      );
    case "remove-debugger":
      return removeLineIfSafe(fileContent, finding.line, (line) =>
        /^\s*debugger\s*;?\s*$/.test(line)
      );
    case "remove-console-log":
      return removeLineIfSafe(fileContent, finding.line, (line) =>
        isSimpleDiagnosticCall(line, "console", ["log", "debug", "trace"])
      );
    case "remove-system-out":
      return removeLineIfSafe(fileContent, finding.line, (line) =>
        isSimpleDiagnosticCall(line, "System", ["out.print", "out.println", "err.print", "err.println"])
      );
    default:
      return null;
  }
}

function replaceLine(
  fileContent: string,
  lineNumber: number,
  replace: (line: string) => string
): string | null {
  const split = splitContent(fileContent);
  const index = lineNumber - 1;
  if (index < 0 || index >= split.lines.length) return null;

  const nextLines = [...split.lines];
  nextLines[index] = replace(nextLines[index]);
  return rejoin(nextLines, split);
}

function removeLineIfSafe(
  fileContent: string,
  lineNumber: number,
  predicate: (line: string) => boolean
): string | null {
  const split = splitContent(fileContent);
  const index = lineNumber - 1;
  if (index < 0 || index >= split.lines.length) return null;
  if (!predicate(split.lines[index])) return null;

  const nextLines = [...split.lines];
  nextLines.splice(index, 1);
  return rejoin(nextLines, split);
}

// Reassemble using the original file's line ending so CRLF files stay CRLF.
// An emptied file collapses to "" (dropping the now-orphaned trailing newline).
function rejoin(lines: string[], split: SplitContent): string {
  if (lines.length === 0) return "";
  return joinContent(lines, split.hasFinalNewline, split.lineEnding);
}

function isSimpleDiagnosticCall(
  line: string,
  receiver: "console" | "System",
  methods: string[]
): boolean {
  const escapedMethods = methods.map(escapeRegex).join("|");
  const pattern =
    receiver === "console"
      ? new RegExp(`^\\s*console\\.(${escapedMethods})\\s*\\((.*)\\)\\s*;?\\s*$`)
      : new RegExp(`^\\s*System\\.(${escapedMethods})\\s*\\((.*)\\)\\s*;?\\s*$`);
  const match = line.match(pattern);
  if (!match) return false;
  return match[2].split(",").every((argument) => isInertDiagnosticArgument(argument.trim()));
}

function isInertDiagnosticArgument(argument: string): boolean {
  if (argument === "") return true;
  if (/^["'`][^"'`]*["'`]$/.test(argument)) return true;
  if (/^-?\d+(?:\.\d+)?$/.test(argument)) return true;
  if (/^(true|false|null|undefined)$/.test(argument)) return true;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(argument)) return true;
  return false;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
