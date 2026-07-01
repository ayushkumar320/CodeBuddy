/**
 * Suggestion model (Proposal 04 Phase 04.6). The suggestion engine reads the
 * signals CodeBuddy already computes — risk, the active plan, the architecture
 * map, incident memory — plus a couple of deterministic checks (missing tests,
 * stale policies) and turns them into a short list of evidence-backed, severity-
 * ranked suggestions. It is strictly read-only: it never edits code, and it
 * never emits a suggestion without evidence. The bias is a careful senior
 * reviewer, not a noisy linter — few strong findings over many weak ones.
 */

export const SUGGESTION_CATEGORIES = [
  "risk",
  "plan_divergence",
  "architecture",
  "incident",
  "missing_test",
  "stale_policy",
] as const;
export type SuggestionCategory = (typeof SUGGESTION_CATEGORIES)[number];

export const SUGGESTION_SEVERITIES = ["info", "low", "medium", "high"] as const;
export type SuggestionSeverity = (typeof SUGGESTION_SEVERITIES)[number];

/** Every suggestion cites at least one of these. No evidence, no suggestion. */
export type SuggestionEvidence = {
  kind: string;
  detail: string;
};

export type Suggestion = {
  /** Stable id (`category:path`) so a UI can dedupe and track across runs. */
  id: string;
  category: SuggestionCategory;
  severity: SuggestionSeverity;
  title: string;
  detail: string;
  path?: string;
  evidence: SuggestionEvidence[];
  /** Optional follow-up command, e.g. `codebuddy risk assess --paths …`. */
  commandHint?: string;
};

export type SuggestionStats = {
  pathsConsidered: number;
  produced: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
};

export type SuggestResult = {
  suggestions: Suggestion[];
  stats: SuggestionStats;
};

export const SEVERITY_RANK: Record<SuggestionSeverity, number> = {
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};
