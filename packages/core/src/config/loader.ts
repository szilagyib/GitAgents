import * as fs from "fs";
import * as path from "path";
import type {
  Rule,
  RuleApplicability,
  RuleMap,
  LanguageRules,
  Personality,
  ReviewContext,
  ParsedRuleFile,
} from "./types.js";

// ---------------------------------------------------------------------------
// parseRuleFile
// ---------------------------------------------------------------------------

/**
 * Parse a markdown rule file.
 *
 * File format:
 *   - Optional YAML frontmatter block delimited by `---`
 *   - H2 sections (`## rule-id`) each containing:
 *       severity: error | warning
 *       <description text>
 */
export function parseRuleFile(content: string): ParsedRuleFile {
  let body = content;
  let extensions: string[] = [];

  // Strip and parse YAML frontmatter if present
  const frontmatterMatch = body.match(/^\s*---\s*\n([\s\S]*?)\n---\s*\n/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    extensions = parseFrontmatterExtensions(frontmatter);
    body = body.slice(frontmatterMatch[0].length);
  }

  const rules: RuleMap = new Map();

  // Split on H2 headings — each `## <id>` starts a rule block.
  // Element 0 is the content before the first `## ` (e.g. the H1 title); it is
  // never a rule block, so skip it and treat every remaining section as a rule.
  const sections = body.split(/^## /m).slice(1);

  for (const section of sections) {
    const trimmed = section.trimStart();
    if (!trimmed) continue;

    // First line is the rule ID
    const newlineIdx = trimmed.indexOf("\n");
    if (newlineIdx === -1) continue;

    const ruleId = trimmed.slice(0, newlineIdx).trim();
    if (!ruleId) continue;

    const rest = trimmed.slice(newlineIdx + 1);

    // Extract severity from `severity: error|warning`
    const severityMatch = rest.match(/^severity:\s*(error|warning)\s*$/m);
    if (!severityMatch) {
      throw new Error(
        `Rule "${ruleId}" has a missing or invalid severity (expected "severity: error" or "severity: warning")`
      );
    }

    const severity = severityMatch[1] as "error" | "warning";
    const applicability = parseRuleApplicability(rest);

    // Extract optional gate flag from `gate: true|false` (case-insensitive). Default false.
    const gateMatch = rest.match(/^gate:\s*(true|false)\s*$/im);
    const gate = gateMatch ? gateMatch[1].toLowerCase() === "true" : false;

    // Everything after the metadata lines is the description
    const description = rest
      .replace(/^severity:\s*(error|warning)\s*\n?/m, "")
      .replace(/^gate:\s*(true|false)\s*\n?/im, "")
      .replace(/^(profiles|signals|requiredSignals):\s*\[[^\]]*\]\s*\n?/gm, "")
      .trim();

    rules.set(ruleId, {
      ruleId,
      severity,
      gate,
      description,
      ...(applicability ? { applicability } : {}),
    });
  }

  return { extensions, rules };
}

function parseRuleApplicability(content: string): RuleApplicability | undefined {
  const profiles = parseMetadataList(content, "profiles");
  const signals = parseMetadataList(content, "signals");
  const requiredSignals = parseMetadataList(content, "requiredSignals");
  if (profiles.length === 0 && signals.length === 0 && requiredSignals.length === 0) return undefined;
  return {
    ...(profiles.length > 0 ? { profiles } : {}),
    ...(signals.length > 0 ? { signals } : {}),
    ...(requiredSignals.length > 0 ? { requiredSignals } : {}),
  };
}

function parseMetadataList(content: string, key: "profiles" | "signals" | "requiredSignals"): string[] {
  const match = content.match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]\\s*$`, "m"));
  if (!match) return [];
  return match[1]
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Parse `extensions: [.java, .kt]` from YAML frontmatter text.
 */
function parseFrontmatterExtensions(frontmatter: string): string[] {
  const match = frontmatter.match(/^extensions:\s*\[([^\]]*)\]/m);
  if (!match) return [];

  return match[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// mergeRules
// ---------------------------------------------------------------------------

/**
 * Merge common rules with language-specific rules.
 * Language rules override common rules that share the same ID.
 * Language-only rules are appended.
 */
export function mergeRules(common: RuleMap, language: RuleMap): RuleMap {
  const merged: RuleMap = new Map(common);
  for (const [id, rule] of language) {
    merged.set(id, rule);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// loadRules
// ---------------------------------------------------------------------------

/**
 * Load all rule markdown files from `rulesDir`.
 * - `common.md` is treated as the common rule set.
 * - All other `.md` files are treated as language rule sets.
 * - Throws if any extension appears in more than one language file.
 */
export function loadRules(rulesDir: string): {
  common: RuleMap;
  languages: LanguageRules[];
} {
  const files = fs
    .readdirSync(rulesDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  let common: RuleMap = new Map();
  const languages: LanguageRules[] = [];
  const extensionOwners = new Map<string, string>(); // extension -> filename

  for (const file of files) {
    const filePath = path.join(rulesDir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = parseRuleFile(content);

    if (file === "common.md") {
      common = parsed.rules;
    } else {
      // Validate no overlapping extensions
      for (const ext of parsed.extensions) {
        const owner = extensionOwners.get(ext);
        if (owner) {
          throw new Error(
            `Extension "${ext}" is claimed by both "${owner}" and "${file}". Each extension may only appear in one language rule file.`
          );
        }
        extensionOwners.set(ext, file);
      }

      const language = path.basename(file, ".md");
      languages.push({ language, extensions: parsed.extensions, rules: parsed.rules });
    }
  }

  return { common, languages };
}

// ---------------------------------------------------------------------------
// loadPersonality
// ---------------------------------------------------------------------------

/** Read personality.md and return its raw content. */
export function loadPersonality(filePath: string): Personality {
  const raw = fs.readFileSync(filePath, "utf-8");
  return { raw };
}

// ---------------------------------------------------------------------------
// loadReviewContext
// ---------------------------------------------------------------------------

/** Read review-context.json, returning a parsed object or an empty default. */
export function loadReviewContext(filePath: string): ReviewContext {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as ReviewContext;
  } catch {
    return { suppressions: [], projectNotes: [] };
  }
}

// ---------------------------------------------------------------------------
// getRulesForFile
// ---------------------------------------------------------------------------

/**
 * Given a file path, return the merged rule set applicable to it.
 * Finds the first LanguageRules whose extensions include the file's extension,
 * then merges common + language rules. Falls back to common-only if no match.
 */
export function getRulesForFile(
  filePath: string,
  common: RuleMap,
  languages: LanguageRules[]
): RuleMap {
  const ext = path.extname(filePath).toLowerCase();

  const languageRules = languages.find((lr) =>
    lr.extensions.some((e: string) => e.toLowerCase() === ext)
  );

  if (!languageRules) return new Map(common);
  return mergeRules(common, languageRules.rules);
}
