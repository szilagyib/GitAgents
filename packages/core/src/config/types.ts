export interface Rule {
  ruleId: string;
  severity: "error" | "warning";
  /** Whether a finding for this rule may block a merge. Independent of display severity. */
  gate: boolean;
  description: string;
  applicability?: RuleApplicability;
}
export type RuleMap = Map<string, Rule>;

export interface RuleApplicability {
  profiles?: string[];
  signals?: string[];
  requiredSignals?: string[];
}

export interface LanguageRules {
  language: string;
  extensions: string[];
  rules: RuleMap;
}

export interface Personality { raw: string; }

export interface Suppression {
  ruleId: string;
  pathPattern: string;
  reason: string;
  addedBy: string;
  addedAt: string;
}

export interface ProjectNote {
  pathPattern: string;
  note: string;
  addedAt: string;
}

export interface ReviewContext {
  suppressions: Suppression[];
  projectNotes: ProjectNote[];
}

export interface ParsedRuleFile {
  extensions: string[];
  rules: RuleMap;
}
