/**
 * Context engine model (Proposal 04 Phase 04.2). The engine assembles a
 * compact, deterministic, explainable slice of project context so Claude/Codex
 * can start a turn — and reason about a pending edit — without a manual
 * `recall`. Everything here is derived from existing services (plan store, risk
 * service, architecture map, Markdown memory); nothing calls an LLM. Outputs
 * are bounded so a large repository cannot blow the caller's context window.
 */

import type { PlanPolicy } from "../core/config-file.js";
import type { IncidentSeverity } from "../core/memory-file-store.js";
import type { PlanStatus } from "../core/plan-file-store.js";
import type { Assessment } from "../risk/types.js";
import type { SavingsStats } from "../savings/types.js";

/** Where the caller/derived target paths came from, for explainability. */
export type PathSource = "paths" | "plan" | "git" | "task" | "none";

export type ProjectIdentity = {
  namespace: string;
  root: string;
};

/** Compact view of an active or referenced plan. Bodies are never inlined. */
export type PlanSummary = {
  id: string;
  title: string;
  status: PlanStatus;
  brief: string;
  filesToTouch: string[];
  risks: string[];
} | null;

export type PolicyRuleSummary = {
  id: string;
  pattern: string;
  message: string;
  weight: number;
};

export type IncidentSummary = {
  id: string;
  severity: IncidentSeverity;
  subject: string;
  summary: string;
  paths: string[];
  resolved: boolean;
  createdAt: string;
};

export type RelevantFactSummary = {
  id: string;
  subject: string;
  summary: string;
  paths: string[];
  confidence: number;
  relevance: number;
  reason: string;
};

/** Top imported/importing modules — a cheap proxy for architectural hotspots. */
export type ArchitectureHotspot = {
  path: string;
  inbound: number;
  outbound: number;
};

export type ArchitectureSummary = {
  moduleCount: number;
  edgeCount: number;
  hotspots: ArchitectureHotspot[];
};

/** Inbound/outbound neighbours of a single target file. */
export type ModuleNeighbours = {
  path: string;
  dependsOn: string[];
  dependedOnBy: string[];
  /**
   * Symbols this file uses from each dependency, when the architecture source
   * knows them (Graphify does; the regex import map does not). Lets an agent see
   * what is actually used without opening the dependency.
   */
  usesSymbols?: Record<string, string[]>;
};

/** A target file's public API as compact signatures (Roadmap N.3). */
export type FileSymbols = {
  path: string;
  signatures: string[];
};

/** A bounded Git diff hunk for a file in the current change set. */
export type DiffHunk = {
  path: string;
  patch: string;
};

/**
 * Token accounting surface. `returnedEstimate` is the size of this payload;
 * `savings` (Phase 04.5) measures it against the cost of reading the represented
 * files' raw source.
 */
export type TokenStats = {
  budget: number;
  returnedEstimate: number;
  savings: SavingsStats;
};

export type BootstrapContext = {
  project: ProjectIdentity;
  plan: PlanSummary;
  policy: PlanPolicy;
  policyRules: PolicyRuleSummary[];
  incidents: IncidentSummary[];
  facts: RelevantFactSummary[];
  architecture: ArchitectureSummary;
  tokens: TokenStats;
  /** One line per included section explaining why it is present. */
  explain: string[];
};

export type BeforeEditContext = {
  project: ProjectIdentity;
  task: string | null;
  targetPaths: string[];
  pathSource: PathSource;
  plan: PlanSummary;
  policy: PlanPolicy;
  policyRules: PolicyRuleSummary[];
  incidents: IncidentSummary[];
  facts: RelevantFactSummary[];
  risks: Assessment;
  neighbours: ModuleNeighbours[];
  /** Public API (signatures) of target files, so the agent needn't read them. */
  symbols: FileSymbols[];
  /** Changed hunks with a small amount of surrounding context, when Git is available. */
  diffs: DiffHunk[];
  tokens: TokenStats;
  explain: string[];
};
