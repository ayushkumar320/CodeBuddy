/**
 * Background index model (Proposal 04 Phase 04.3). The indexer builds a
 * deterministic, local-first picture of the repository — one content hash and
 * one lightweight summary per indexable file — so CodeBuddy knows something
 * useful before any memory is manually written. It is a derived *cache* under
 * `.codebuddy/cache/`, never a source of truth: deleting it and re-running
 * `codebuddy index` reproduces it exactly. No LLM is involved; summaries are
 * extracted with simple, stable heuristics.
 */

import type { SymbolSpan } from "./symbols.js";

export const INDEX_MANIFEST_VERSION = 1 as const;

/** One indexed file. Everything here is reproducible from the file contents. */
export type IndexEntry = {
  /** Repo-relative POSIX path. */
  path: string;
  /** SHA-256 of the file contents; the sole change-detection signal. */
  hash: string;
  /** Byte size at index time. */
  size: number;
  /** Coarse language tag derived from the extension (ts, js, md, py, …). */
  language: string;
  /** Line count (excluding a single trailing newline). */
  lines: number;
  /** Best-effort top-level/exported symbol names. Empty for non-code files. */
  symbols: string[];
  /**
   * Optional richer symbol table (name/kind/range/signature) for code files —
   * the basis for symbol-level context (Roadmap N.3). Absent for non-code files
   * and older manifests, so consumers must treat it as optional.
   */
  symbolTable?: SymbolSpan[];
  /** Deterministic one-line summary. */
  summary: string;
  /** ISO timestamp of when this entry was (re)computed. */
  indexedAt: string;
};

export type IndexManifest = {
  version: typeof INDEX_MANIFEST_VERSION;
  generatedAt: string;
  /** Keyed by repo-relative POSIX path. */
  entries: Record<string, IndexEntry>;
};

export type IndexError = {
  path: string;
  error: string;
};

/** Outcome of one indexing pass. Counts are disjoint where noted. */
export type IndexResult = {
  scanned: number;
  added: number;
  changed: number;
  /** Unchanged files whose summary was reused (the incremental fast path). */
  unchanged: number;
  /** Entries dropped because the file no longer exists or is now ignored. */
  removed: number;
  /** Files skipped as too large or unreadable (isolated, non-fatal). */
  skipped: number;
  errors: IndexError[];
  durationMs: number;
  totalIndexed: number;
};
