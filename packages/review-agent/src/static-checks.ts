import type { Finding } from "@gitagents/core";

type StaticCheck = {
  ruleId: string;
  severity: Finding["severity"];
  confidence: Finding["confidence"];
  autoFixable: boolean;
  fixStrategy: NonNullable<Finding["fixStrategy"]>;
  fixabilityReason: string;
  test: (line: string, index: number, fileLines: string[], filePath: string) => boolean;
  message: (line: string) => string;
  suggestedApproach: string;
};

const JS_TS_EXTENSIONS = /\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)$/;
const JAVA_EXTENSION = /\.java$/;
const CPP_EXTENSIONS = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/;
const TEST_PATH = /(^|[\\/])(__tests__|test|tests|spec)([\\/]|$)|\.(spec|test)\.[cm]?[jt]sx?$/;
const JAVA_STRING_EQUALITY = /("[^"]*"\s*[!=]=\s*[\w.()]+|[\w.()]+\s*[!=]=\s*"[^"]*")/;
const JS_TS_LOOSE_EQUALITY = /(^|[^=!])(?:==|!=)(?!=)/;

const CHECKS: StaticCheck[] = [
  {
    ruleId: "merge-conflict-marker",
    severity: "error",
    confidence: "high",
    autoFixable: false,
    fixStrategy: "manual-only",
    fixabilityReason: "Conflict markers require choosing the intended final code.",
    test: (line, index, fileLines) => {
      const trimmed = line.trim();
      // The angle markers are unambiguous and fire on their own.
      if (/^(<<<<<<<|>>>>>>>)(\s|$)/.test(trimmed)) return true;
      // `=======` also occurs as a Markdown setext underline, so only treat it
      // as a conflict marker when an angle marker sits within +/-3 lines.
      if (/^=======(\s|$)/.test(trimmed)) return hasNearbyAngleMarker(index, fileLines);
      return false;
    },
    message: () => "Merge conflict marker committed. Resolve it before this can build.",
    suggestedApproach: "Resolve the conflict and commit the intended final code.",
  },
  {
    ruleId: "focused-test",
    severity: "error",
    confidence: "high",
    autoFixable: true,
    fixStrategy: "remove-focused-test",
    fixabilityReason: "Removing .only restores normal test-suite execution without changing test logic.",
    test: (line, _index, _fileLines, filePath) =>
      JS_TS_EXTENSIONS.test(filePath) && /\b(describe|it|test)\.only\s*\(/.test(line),
    message: () => "Focused test committed with .only, so the suite can silently skip everything else.",
    suggestedApproach: "Remove .only so the full test suite runs.",
  },
  {
    ruleId: "debugger-statement",
    severity: "error",
    confidence: "high",
    autoFixable: true,
    fixStrategy: "remove-debugger",
    fixabilityReason: "Removing a debugger statement is a local non-behavioral cleanup.",
    test: (line, _index, _fileLines, filePath) =>
      JS_TS_EXTENSIONS.test(filePath) && /^\s*debugger\s*;?\s*$/.test(line),
    message: () => "debugger statement left in changed code.",
    suggestedApproach: "Remove the debugger statement.",
  },
  {
    ruleId: "console-log",
    severity: "warning",
    confidence: "medium",
    autoFixable: true,
    fixStrategy: "remove-console-log",
    fixabilityReason: "Removing diagnostic console output is local and preserves production behavior.",
    test: (line, _index, _fileLines, filePath) =>
      JS_TS_EXTENSIONS.test(filePath) &&
      !TEST_PATH.test(filePath) &&
      /\bconsole\.(log|debug|trace)\s*\(/.test(line),
    message: () => "Console logging left in production code.",
    suggestedApproach: "Remove it or use the project's structured logger if this is intentional.",
  },
  {
    ruleId: "system-out",
    severity: "warning",
    confidence: "medium",
    autoFixable: true,
    fixStrategy: "remove-system-out",
    fixabilityReason: "Removing direct System.out/System.err output is local and preserves production behavior.",
    test: (line, _index, _fileLines, filePath) =>
      JAVA_EXTENSION.test(filePath) &&
      !TEST_PATH.test(filePath) &&
      /\bSystem\.(out|err)\.print/.test(line),
    message: () => "System.out/System.err logging left in production Java code.",
    suggestedApproach: "Remove it or use the project's logger.",
  },
  {
    ruleId: "empty-catch",
    severity: "error",
    confidence: "high",
    autoFixable: false,
    fixStrategy: "manual-only",
    fixabilityReason: "The correct handling behavior depends on the exception semantics.",
    test: (line, index, fileLines) => {
      if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) return true;
      if (!/catch\s*\([^)]*\)\s*\{\s*$/.test(line)) return false;
      const nextMeaningful = fileLines
        .slice(index + 1)
        .find((candidate) => candidate.trim() !== "");
      return nextMeaningful?.trim() === "}";
    },
    message: () => "Empty catch block swallows failures and hides production bugs.",
    suggestedApproach: "Log, rethrow, or handle the exception explicitly.",
  },
  {
    ruleId: "string-comparison",
    severity: "error",
    confidence: "medium",
    autoFixable: false,
    fixStrategy: "manual-only",
    fixabilityReason: "Changing string comparison safely can depend on null handling and expected equality semantics.",
    test: (line, _index, _fileLines, filePath) =>
      JAVA_EXTENSION.test(filePath) && JAVA_STRING_EQUALITY.test(stripLineComment(line)),
    message: () => "Java string comparison uses ==/!=, which compares references instead of values.",
    suggestedApproach: "Use .equals() or Objects.equals(), preserving the intended null behavior.",
  },
  {
    ruleId: "optional-usage",
    severity: "error",
    confidence: "medium",
    autoFixable: false,
    fixStrategy: "manual-only",
    fixabilityReason: "Replacing Optional.get() safely requires knowing the intended empty-value behavior.",
    test: (line, index, fileLines, filePath) =>
      JAVA_EXTENSION.test(filePath) && hasUnguardedOptionalGet(line, index, fileLines),
    message: () => "Optional.get() is used without a nearby presence guard, so empty Optional will throw.",
    suggestedApproach: "Use orElse/orElseThrow/ifPresent, or guard with isPresent/isEmpty before calling get().",
  },
  {
    ruleId: "async-errors",
    severity: "error",
    confidence: "medium",
    autoFixable: false,
    fixStrategy: "manual-only",
    fixabilityReason: "The correct handling for a floating promise depends on whether it should block, report, or intentionally run in the background.",
    test: (line, _index, _fileLines, filePath) =>
      JS_TS_EXTENSIONS.test(filePath) && hasLikelyFloatingPromise(line),
    message: () => "Promise-like call is fired without await, return, void, or error handling.",
    suggestedApproach: "Await or return the promise, or explicitly use void plus a catch/logging path for intentional fire-and-forget.",
  },
  {
    ruleId: "strict-typing",
    severity: "error",
    confidence: "medium",
    autoFixable: false,
    fixStrategy: "manual-only",
    fixabilityReason: "Changing loose equality safely depends on whether coercion was intentional.",
    test: (line, _index, _fileLines, filePath) =>
      JS_TS_EXTENSIONS.test(filePath) && hasUnsafeLooseEquality(line),
    message: () => "Loose equality in TypeScript/JavaScript can hide coercion bugs.",
    suggestedApproach: "Use ===/!== with explicit normalization if coercion was intended.",
  },
  {
    ruleId: "buffer-bounds",
    severity: "error",
    confidence: "high",
    autoFixable: false,
    fixStrategy: "manual-only",
    fixabilityReason: "Replacing unsafe C string APIs safely requires knowing buffer sizes and truncation policy.",
    test: (line, _index, _fileLines, filePath) =>
      CPP_EXTENSIONS.test(filePath) && /\b(gets|strcpy|strcat|sprintf)\s*\(/.test(stripLineComment(line)),
    message: () => "Unsafe C string/buffer API can write past the destination buffer.",
    suggestedApproach: "Use a bounded API or safer abstraction and handle truncation/error cases explicitly.",
  },
  {
    ruleId: "format-string",
    severity: "error",
    confidence: "medium",
    autoFixable: false,
    fixStrategy: "manual-only",
    fixabilityReason: "The safe replacement depends on the intended format and argument list.",
    test: (line, _index, _fileLines, filePath) =>
      CPP_EXTENSIONS.test(filePath) && hasVariableFormatString(line),
    message: () => "Format function uses a non-literal format string, which can become a format-string vulnerability.",
    suggestedApproach: "Use a literal format string and pass untrusted/user-controlled text as a normal argument.",
  },
  {
    ruleId: "portability",
    severity: "warning",
    confidence: "high",
    autoFixable: false,
    fixStrategy: "manual-only",
    fixabilityReason: "The intended supported compiler/platform matrix is a project decision.",
    test: (line, _index, _fileLines, filePath) =>
      CPP_EXTENSIONS.test(filePath) && /#include\s*<bits\/stdc\+\+\.h>/.test(stripLineComment(line)),
    message: () => "<bits/stdc++.h> is a non-standard GCC header and breaks portability.",
    suggestedApproach: "Include the specific standard headers required by this file.",
  },
  {
    ruleId: "buffer-bounds",
    severity: "error",
    confidence: "high",
    autoFixable: false,
    fixStrategy: "manual-only",
    fixabilityReason: "Fixing sizeof(pointer) requires choosing the correct byte count or container abstraction.",
    test: (line, index, fileLines, filePath) =>
      CPP_EXTENSIONS.test(filePath) && hasSizeofPointerInByteOperation(line, index, fileLines),
    message: () => "sizeof is applied to a pointer in a byte-count operation, so only the pointer size is used.",
    suggestedApproach: "Pass the actual buffer length, use sizeof on the real array object, or switch to a bounds-aware abstraction.",
  },
  {
    ruleId: "memory-lifetime",
    severity: "error",
    confidence: "high",
    autoFixable: false,
    fixStrategy: "manual-only",
    fixabilityReason: "Changing delete/delete[] safely requires confirming allocation ownership and lifetime.",
    test: (line, index, fileLines, filePath) =>
      CPP_EXTENSIONS.test(filePath) && hasDeleteMismatch(line, index, fileLines),
    message: () => "delete form does not match the nearby new allocation form.",
    suggestedApproach: "Use delete[] for arrays, delete for scalar objects, or replace raw ownership with RAII.",
  },
];

export function runStaticChecks(
  filePath: string,
  fileLines: string[],
  changedLines: number[]
): Finding[] {
  const findings: Finding[] = [];

  for (const lineNumber of changedLines) {
    const line = fileLines[lineNumber - 1] ?? "";
    const index = lineNumber - 1;

    for (const check of CHECKS) {
      if (!check.test(line, index, fileLines, filePath)) continue;

      findings.push({
        line: lineNumber,
        severity: check.severity,
        confidence: check.confidence,
        ruleId: check.ruleId,
        autoFixable: check.autoFixable,
        fixStrategy: check.fixStrategy,
        fixabilityReason: check.fixabilityReason,
        message: check.message(line),
        codeContext: line.trim(),
        suggestedApproach: check.suggestedApproach,
        origin: "static",
      });
    }
  }

  return findings;
}

function stripLineComment(line: string): string {
  return line.replace(/\/\/.*$/, "");
}

function hasNearbyAngleMarker(index: number, fileLines: string[]): boolean {
  const start = Math.max(0, index - 3);
  const end = Math.min(fileLines.length - 1, index + 3);
  for (let i = start; i <= end; i++) {
    if (i === index) continue;
    if (/^(<<<<<<<|>>>>>>>)(\s|$)/.test((fileLines[i] ?? "").trim())) return true;
  }
  return false;
}

function hasUnguardedOptionalGet(line: string, index: number, fileLines: string[]): boolean {
  const match = stripLineComment(line).match(/\b([A-Za-z_]\w*)\.get\s*\(\s*\)/);
  if (!match) return false;
  const variableName = match[1];
  const nearby = fileLines
    .slice(Math.max(0, index - 4), index + 1)
    .join("\n");
  const guardedPattern = new RegExp(
    `\\b${escapeRegExp(variableName)}\\.(isPresent|isEmpty)\\s*\\(`,
  );
  return !guardedPattern.test(nearby);
}

function hasLikelyFloatingPromise(line: string): boolean {
  const code = stripLineComment(line).trim();
  if (!code.endsWith(";")) return false;
  if (/^(await|return|throw|void)\b/.test(code)) return false;
  if (/\.catch\s*\(|\.then\s*\([^)]*,/.test(code)) return false;
  return /\b([A-Za-z_]\w*Async|Promise\.(resolve|reject|all|race|allSettled|any)|fetch)\s*\(/.test(code);
}

function hasUnsafeLooseEquality(line: string): boolean {
  const code = stripLineComment(line);
  if (!JS_TS_LOOSE_EQUALITY.test(code)) return false;
  return !/(^|[^=!])(?:==|!=)\s*(null|undefined)\b/.test(code);
}

function hasVariableFormatString(line: string): boolean {
  const code = stripLineComment(line).trim();
  const call = code.match(/\b(printf|fprintf|sprintf|snprintf|syslog)\s*\((.*)\)/);
  if (!call) return false;

  const functionName = call[1];
  const args = splitTopLevelArgs(call[2]);
  const formatArgIndex = getFormatArgIndex(functionName);
  const formatArg = args[formatArgIndex]?.trim();
  return Boolean(formatArg && !formatArg.startsWith("\""));
}

function getFormatArgIndex(functionName: string): number {
  switch (functionName) {
    case "printf":
      return 0;
    case "fprintf":
    case "sprintf":
    case "syslog":
      return 1;
    case "snprintf":
      return 2;
    default:
      return 0;
  }
}

function hasSizeofPointerInByteOperation(line: string, index: number, fileLines: string[]): boolean {
  const code = stripLineComment(line);
  const match = code.match(/\b(?:memcpy|memmove|memset|memcmp|read|write)\s*\([^;]*\bsizeof\s*\(\s*([A-Za-z_]\w*)\s*\)/);
  if (!match) return false;
  const variableName = match[1];
  if (new RegExp(`\\b${escapeRegExp(variableName)}\\s*\\[[^\\]]+\\]`).test(code)) return false;
  return hasNearbyPointerDeclaration(variableName, index, fileLines);
}

function hasNearbyPointerDeclaration(variableName: string, index: number, fileLines: string[]): boolean {
  const nearby = fileLines
    .slice(Math.max(0, index - 25), Math.min(fileLines.length, index + 2))
    .map(stripLineComment)
    .join("\n");
  const escaped = escapeRegExp(variableName);
  const pointerDeclaration = new RegExp(`(?:\\*\\s*${escaped}\\b|\\b${escaped}\\s*\\[\\s*\\])`);
  const pointerAllocation = new RegExp(`\\b${escaped}\\s*=\\s*(?:\\([^)]*\\)\\s*)?(?:malloc|calloc|realloc)\\s*\\(|\\b${escaped}\\s*=\\s*new\\b`);
  return pointerDeclaration.test(nearby) || pointerAllocation.test(nearby);
}

function hasDeleteMismatch(line: string, index: number, fileLines: string[]): boolean {
  const code = stripLineComment(line);
  const match = code.match(/\bdelete(\s*\[\s*\])?\s+([A-Za-z_]\w*)\s*;/);
  if (!match) return false;
  const usesArrayDelete = Boolean(match[1]);
  const variableName = match[2];
  const allocation = findNearbyNewAllocation(variableName, index, fileLines);
  if (!allocation) return false;
  return allocation === "array" ? !usesArrayDelete : usesArrayDelete;
}

function findNearbyNewAllocation(
  variableName: string,
  index: number,
  fileLines: string[]
): "array" | "scalar" | undefined {
  const escaped = escapeRegExp(variableName);
  const assignmentPattern = new RegExp(`\\b${escaped}\\s*=\\s*new\\b([^;]*)`);
  const declarationPattern = new RegExp(`\\b${escaped}\\s*(?:\\{|=)\\s*new\\b([^;]*)`);

  for (let i = index; i >= Math.max(0, index - 40); i--) {
    const code = stripLineComment(fileLines[i] ?? "");
    const match = code.match(assignmentPattern) ?? code.match(declarationPattern);
    if (!match) continue;
    return /\[[^\]]*\]/.test(match[1]) ? "array" : "scalar";
  }

  return undefined;
}

function splitTopLevelArgs(argsText: string): string[] {
  const args: string[] = [];
  let current = "";
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (const char of argsText) {
    if (inString) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      current += char;
      continue;
    }

    if (char === "(" || char === "[" || char === "{") depth++;
    if (char === ")" || char === "]" || char === "}") depth--;

    if (char === "," && depth === 0) {
      args.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim() !== "") args.push(current);
  return args;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
