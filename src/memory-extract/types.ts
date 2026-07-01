/**
 * Automatic memory extraction model (Proposal 04 Phase 04.4). After a coding
 * turn, CodeBuddy turns a short summary into structured memory *candidates*,
 * classifies each, and — only when confidence and safety allow — saves durable
 * Markdown. Everything else is routed to a reviewable queue or dropped. The
 * guiding rule: prefer a false negative (missed memory) over a false durable
 * fact. Junk memory poisons recall, so capture is deliberately conservative.
 */

import { z } from "zod";
import type { IncidentSeverity } from "../core/memory-file-store.js";

/** How a candidate is classified. `ignored` is chatter we deliberately drop. */
export const MEMORY_CLASSES = ["fact", "decision", "incident", "note", "ignored"] as const;
export type MemoryClass = (typeof MEMORY_CLASSES)[number];

/** What ultimately happened to a candidate. */
export type CandidateOutcome = "saved" | "queued" | "ignored";

/**
 * A single extracted memory candidate, before gating. `content` is the human
 * sentence; the subject/predicate/object triple mirrors the durable fact
 * schema so an approved candidate maps cleanly onto `MemoryFileStore`.
 */
export type MemoryCandidate = {
  class: MemoryClass;
  content: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  paths: string[];
  severity: IncidentSeverity | null;
};

/** Zod schema used to validate extractor (esp. LLM) output strictly. */
export const memoryCandidateSchema = z.object({
  class: z.enum(MEMORY_CLASSES),
  content: z.string().min(1),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  confidence: z.number().min(0).max(1),
  paths: z.array(z.string().min(1)).default([]),
  severity: z.enum(["low", "medium", "high", "critical"]).nullable().default(null),
});

export type ExtractionInput = {
  summary: string;
  namespace: string;
  changedFiles?: string[];
  planId?: string;
  taskType?: string;
  agentId?: string;
};

/** A candidate paired with the gating decision made about it. */
export type CandidateDecision = {
  candidate: MemoryCandidate;
  outcome: CandidateOutcome;
  reason: string;
  /** Present when the outcome is `saved` (fact id) or `queued` (review id). */
  ref?: string;
  sensitive: boolean;
  sensitiveReasons: string[];
};

export type AfterTurnResult = {
  saved: CandidateDecision[];
  queuedForReview: CandidateDecision[];
  ignored: CandidateDecision[];
  /** One line per decision, for explainability. */
  reasons: string[];
  extractor: "deterministic" | "llm";
};
