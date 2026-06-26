/**
 * Risk model (Proposal 03.1). A risk assessment is a deterministic,
 * evidence-backed ranking of the files in a pending change set. Every score
 * traces to one or more signals, and every signal cites its evidence — a risk
 * that cannot be explained is noise, not risk. No LLM judgement enters here.
 */

export type RiskCategory = "blast_radius" | "churn" | "incident" | "type_failure" | "policy";

export type Evidence =
  | { kind: "dependent_module"; path: string; depth: number }
  | { kind: "git_commit"; sha: string; message: string; ts: string }
  | { kind: "memory_fact"; factId: string; content: string; createdAt: string }
  | { kind: "ci_failure"; runId: string; conclusion: string; ts: string }
  | { kind: "policy_rule"; ruleId: string; pattern: string };

/** One signal's verdict on one path. */
export type SignalContribution = {
  path: string;
  /** 0–100 within this signal's own scale. */
  weight: number;
  reason: string;
  evidence: Evidence[];
};

export type AssessmentInput = {
  /** Repo-relative paths in the change set. */
  paths: string[];
  /** Repository root, for signals that read the filesystem or git. */
  repositoryRoot: string;
  namespace: string;
};

export type Signal = {
  id: string;
  category: RiskCategory;
  /** Disabled signals are skipped entirely. */
  enabled: boolean;
  /** Relative importance when folding contributions into a score. */
  coefficient: number;
  assess(input: AssessmentInput): Promise<SignalContribution[]>;
};

export type RiskItem = {
  path: string;
  /** 0–100 aggregate. */
  score: number;
  /** The category of the signal that contributed the most weight. */
  category: RiskCategory;
  /** The dominant signal's reason, for a one-line summary. */
  reason: string;
  /** Ids of every signal that contributed to this path. */
  contributingSignals: string[];
  evidence: Evidence[];
};

export type SignalStat = {
  id: string;
  category: RiskCategory;
  contributions: number;
  totalWeight: number;
};

export type AssessmentStats = {
  pathsConsidered: number;
  itemsProduced: number;
  signalsRun: number;
  perSignal: SignalStat[];
};

export type Assessment = {
  items: RiskItem[];
  stats: AssessmentStats;
};
