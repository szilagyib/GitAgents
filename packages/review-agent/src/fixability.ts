import type { Finding } from "@gitagents/core";

const NEVER_AUTOFIX_RULE_IDS = new Set([
  "authorization",
  "backward-compatibility",
  "buffer-bounds",
  "cpp-header-impact",
  "data-integrity",
  "empty-catch",
  "format-string",
  "merge-conflict-marker",
  "missing-file-reference",
  "portability",
  "secret-handling",
  "transaction-boundaries",
]);

const BROAD_FIX_SIGNALS =
  /\b(product decision|ticket context|business rule|schema|migration|database migration|public api|api contract|cross-file|multi-file|broad refactor|architecture|dependency|import change|new default invented|security policy|permission model)\b/;

export function normalizeFixability(filePath: string, finding: Finding): Finding {
  if (finding.confidence === "low") {
    return markManual(finding, "Low-confidence findings are not safe for automatic edits.");
  }

  if (NEVER_AUTOFIX_RULE_IDS.has(finding.ruleId)) {
    return markManual(finding, "This rule is intentionally blocked from automatic edits.");
  }

  if (hasBroadFixSignals(finding)) {
    return markManual(finding, "This fix needs broader context than one safe local patch.");
  }

  if (finding.autoFixable) {
    return withFixStrategy(filePath, finding);
  }

  if (!looksLikeEasyLocalFix(filePath, finding)) return finding;

  return withFixStrategy(filePath, {
    ...finding,
    autoFixable: true,
    fixabilityReason:
      "Review-side policy classified this as a same-file local fix that does not need product context or multi-file editing.",
  });
}

function withFixStrategy(filePath: string, finding: Finding): Finding {
  const strategy =
    finding.fixStrategy && finding.fixStrategy !== "manual-only"
      ? finding.fixStrategy
      : inferFixStrategy(filePath, finding);

  return {
    ...finding,
    autoFixable: true,
    fixStrategy: strategy,
    fixabilityReason:
      finding.fixabilityReason ??
      "This can be fixed with a narrow same-file patch.",
  };
}

function markManual(finding: Finding, reason?: string): Finding {
  return {
    ...finding,
    autoFixable: false,
    fixStrategy: "manual-only",
    fixabilityReason:
      reason ??
      finding.fixabilityReason ??
      "This needs developer judgment or a change outside one safe local patch.",
  };
}

function inferFixStrategy(filePath: string, finding: Finding): NonNullable<Finding["fixStrategy"]> {
  const text = findingText(finding);

  if (/\bdebugger\b/.test(text)) return "remove-debugger";
  if (/\b(focused test|\.only)\b/.test(text)) return "remove-focused-test";
  if (/\bconsole\.(log|debug|trace)\b/.test(text)) return "remove-console-log";
  if (/\bsystem\.(out|err)\.print/.test(text)) return "remove-system-out";
  if (isNullishFinding(text)) {
    if (isTypeScriptFile(filePath) && /\b(optional chaining|optional chain|\?\.)\b/.test(text)) {
      return "optional-chain";
    }
    if (/\b(nullish|coalescing|\?\?|default|fallback)\b/.test(text)) {
      return "nullish-coalescing";
    }
    if (/\b(requireNonNull|require non-null|fail fast|precondition|must not be null)\b/i.test(text)) {
      return "require-non-null";
    }
    return "local-null-guard";
  }

  return "generic-local-edit";
}

function looksLikeEasyLocalFix(filePath: string, finding: Finding): boolean {
  const text = findingText(finding);
  return (
    isNullishFinding(text) ||
    /\b(typecast|type cast|unchecked cast|type assertion|instanceof|type guard|classcastexception)\b/.test(text) ||
    /\b(typo|spelling|misspell|misspelled|mispelled)\b/.test(text) ||
    /\b(string comparison|reference equality|objects\.equals|\.equals\(\)|loose equality|strict equality)\b/.test(text) ||
    /(^|[^=!])(?:==|!=)(?!=)/.test(text) ||
    /===|!==/.test(text) ||
    /\b(missing await|floating promise|return the promise|await the promise)\b/.test(text) ||
    /\b(wrong operator|inverted condition|one-line|single-line|local edit)\b/.test(text) ||
    /\bdebugger\b/.test(text) ||
    /\bconsole\.(log|debug|trace)\b/.test(text) ||
    /\bsystem\.(out|err)\.print/.test(text) ||
    (isTypeScriptFile(filePath) && /\boptional chaining\b/.test(text))
  );
}

function isNullishFinding(text: string): boolean {
  return /\b(null pointer|nullpointerexception|null dereference|null-dereference|npe|undefined dereference|cannot read propert|may be null|may be undefined|possibly null|possibly undefined)\b/.test(text);
}

function hasBroadFixSignals(finding: Finding): boolean {
  return BROAD_FIX_SIGNALS.test(findingText(finding));
}

function findingText(finding: Finding): string {
  return [
    finding.ruleId,
    finding.message,
    finding.codeContext,
    finding.suggestedApproach,
    finding.fixabilityReason,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isTypeScriptFile(filePath: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(filePath);
}
