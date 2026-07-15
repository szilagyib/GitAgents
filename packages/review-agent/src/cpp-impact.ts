import type { Finding } from "@gitagents/core";
import type { FileDiff } from "@gitagents/forge";

export interface CppHeaderImpactInput {
  filePath: string;
  fileLines: string[];
  changedLines: number[];
  diffs: FileDiff[];
}

const CPP_HEADER = /\.(h|hh|hpp|hxx)$/i;
const CPP_SOURCE = /\.(c|cc|cpp|cxx)$/i;

export function detectCppHeaderImpact(input: CppHeaderImpactInput): Finding[] {
  if (!CPP_HEADER.test(input.filePath)) return [];
  if (hasCppSourceChange(input.diffs)) return [];

  const findings: Finding[] = [];
  for (const lineNumber of input.changedLines) {
    const line = input.fileLines[lineNumber - 1] ?? "";
    const impact = classifyHeaderApiChange(line);
    if (!impact) continue;

    findings.push({
      line: lineNumber,
      severity: "warning",
      confidence: "medium",
      ruleId: "header-api-impact",
      autoFixable: false,
      fixStrategy: "manual-only",
      fixabilityReason: "Header API changes can require implementation, caller, ABI, or serialization updates across files.",
      message: `${impact} changed in a C/C++ header, but this MR does not change any C/C++ source file.`,
      codeContext: line.trim(),
      suggestedApproach: "Verify corresponding implementations, callers, tests, ABI expectations, and generated bindings are updated.",
    });
  }

  return findings;
}

function hasCppSourceChange(diffs: FileDiff[]): boolean {
  return diffs.some((diff) => !diff.deletedFile && CPP_SOURCE.test(diff.newPath));
}

function classifyHeaderApiChange(line: string): string | undefined {
  const code = stripInlineComment(line).trim();
  if (!code || code.startsWith("#")) return undefined;
  if (/^(private|protected|public)\s*:/.test(code)) return undefined;

  if (/^(struct|class)\s+[A-Za-z_]\w*/.test(code)) {
    return "Public type declaration";
  }
  if (/^enum(?:\s+class)?\s+[A-Za-z_]\w*/.test(code)) {
    return "Enum declaration";
  }
  if (isFunctionDeclaration(code)) {
    return "Function declaration";
  }
  if (isLikelyFieldDeclaration(code)) {
    return "Data member declaration";
  }

  return undefined;
}

function isFunctionDeclaration(code: string): boolean {
  if (!/\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:final\s*)?(?:=\s*0\s*)?;?$/.test(code)) {
    return false;
  }
  if (/\b(if|for|while|switch|return|sizeof|static_assert)\s*\(/.test(code)) return false;
  if (/\b(default|delete)\s*;?$/.test(code)) return false;
  return true;
}

function isLikelyFieldDeclaration(code: string): boolean {
  if (!code.endsWith(";")) return false;
  if (code.includes("(") || code.includes(")") || code.includes("=")) return false;
  if (/^(using|typedef|friend|static_assert)\b/.test(code)) return false;
  return /\b[A-Za-z_]\w*(?:\s*[*&])?\s+[A-Za-z_]\w*(?:\[[^\]]*\])?\s*;/.test(code);
}

function stripInlineComment(line: string): string {
  return line.replace(/\/\/.*$/, "");
}
