/**
 * Token-savings model (Proposal 04 Phase 04.5). CodeBuddy's value claim is that
 * it hands an agent compact summaries and references instead of raw source. This
 * module measures that claim against a concrete baseline — the tokens it would
 * take to read the same files' raw contents — so the savings are real, not
 * cosmetic. Everything is deterministic (≈4 chars/token) and explainable: every
 * number traces to a file or a section, and nothing important is dropped just to
 * make the count look smaller.
 */

/** Per-section returned-token breakdown, so callers can see where tokens go. */
export type StageStat = {
  stage: string;
  returnedTokens: number;
};

/** Cross-turn context transmission measured by the session capsule ledger. */
export type SessionSavingsStats = {
  fullCapsules: number;
  referencedCapsules: number;
  sentTokens: number;
  avoidedRepeatTokens: number;
};

/** Stable, machine-consumable savings summary. Future UI can rely on these keys. */
export type SavingsStats = {
  /** True when a baseline exists to measure against (files were represented). */
  available: boolean;
  budget: number;
  /** Tokens the naive alternative would cost (raw source of represented files). */
  baselineTokens: number;
  /** Tokens actually returned in the compact payload. */
  returnedTokens: number;
  /** max(0, baseline − returned). */
  savedTokens: number;
  /** returned / baseline, clamped to [0, 1]; 1 when there is no baseline. */
  compressionRatio: number;
  withinBudget: boolean;
  representedFiles: number;
  stages: StageStat[];
  note?: string;
};

/**
 * A cacheable, dedupable compact representation of one file: its summary and
 * symbols in place of its raw contents. The `id` is a content hash so repeated
 * topics collapse to one capsule.
 */
export type FileCapsule = {
  id: string;
  path: string;
  summary: string;
  symbols: string[];
  rawTokens: number;
  summaryTokens: number;
  savedTokens: number;
};

export type DirectorySummary = {
  directory: string;
  files: number;
  lines: number;
  languages: Record<string, number>;
  symbols: string[];
};

export type ProjectSummary = {
  files: number;
  lines: number;
  languages: Record<string, number>;
  topDirectories: DirectorySummary[];
};

export type RepoSavings = {
  savings: SavingsStats;
  project: ProjectSummary;
};

// ── budget packing ───────────────────────────────────────────────────

/** A candidate for packing. Higher `priority` survives a tight budget first. */
export type PackCandidate<T> = {
  value: T;
  priority: number;
  text: string;
  /** Optional smaller rendering used when the full text does not fit. */
  compressedText?: string;
};

export type PackedStatus = "included" | "compressed" | "skipped";

export type PackedItem<T> = {
  value: T;
  status: PackedStatus;
  tokens: number;
  reason: string;
};

export type PackStats = {
  budget: number;
  /** Tokens if every candidate were included at full size. */
  candidateTokens: number;
  returnedTokens: number;
  savedTokens: number;
  included: number;
  compressed: number;
  skipped: number;
  compressionRatio: number;
};

export type PackResult<T> = {
  items: PackedItem<T>[];
  stats: PackStats;
};
