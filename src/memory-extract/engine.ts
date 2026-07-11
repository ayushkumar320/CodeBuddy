import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { generateEntityId } from "../core/ids.js";
import { MemoryFileStore } from "../core/memory-file-store.js";
import { type ExtractOptions, extractCandidates } from "./llm.js";
import { ReviewStore } from "./review-store.js";
import { scanSensitive } from "./sensitive.js";
import type {
  AfterTurnResult,
  CandidateDecision,
  ExtractionInput,
  MemoryCandidate,
} from "./types.js";

/**
 * The capture orchestrator (`context_after_turn`). It extracts candidates,
 * then gates each one:
 *
 *   - `ignored`               → dropped.
 *   - sensitive content       → queued for review, flagged (never auto-saved).
 *   - `note` (temporary)      → queued for review (never durable).
 *   - confident fact/decision/incident (≥ threshold) → saved as durable Markdown.
 *   - everything else         → queued for review (low confidence).
 *
 * The bias is deliberate: durable memory is the exception, review is the rule.
 */

/** Minimum confidence for a fact/decision/incident to skip review. */
const AUTO_SAVE_THRESHOLD = 0.7;

export type CaptureOptions = ExtractOptions & {
  repositoryRoot?: string;
  now?: () => Date;
};

export async function captureAfterTurn(
  input: ExtractionInput,
  options: CaptureOptions = {},
): Promise<AfterTurnResult> {
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const now = options.now ?? (() => new Date());
  const memoryStore = new MemoryFileStore(repositoryRoot);
  const reviewStore = new ReviewStore(repositoryRoot);

  const { candidates, source } = await extractCandidates(input, options);

  const saved: CandidateDecision[] = [];
  const queuedForReview: CandidateDecision[] = [];
  const ignored: CandidateDecision[] = [];
  const reasons: string[] = [];

  for (const candidate of candidates) {
    const sensitivity = scanSensitive(`${candidate.content} ${candidate.object}`);
    const decision = await gate({
      candidate,
      input,
      sensitivity,
      memoryStore,
      reviewStore,
      now,
    });
    reasons.push(`${candidate.class}: ${decision.outcome} — ${decision.reason}`);
    if (decision.outcome === "saved") saved.push(decision);
    else if (decision.outcome === "queued") queuedForReview.push(decision);
    else ignored.push(decision);
  }

  return { saved, queuedForReview, ignored, reasons, extractor: source };
}

async function gate(args: {
  candidate: MemoryCandidate;
  input: ExtractionInput;
  sensitivity: ReturnType<typeof scanSensitive>;
  memoryStore: MemoryFileStore;
  reviewStore: ReviewStore;
  now: () => Date;
}): Promise<CandidateDecision> {
  const { candidate, sensitivity } = args;
  const fingerprint = candidateFingerprint(args.input.namespace, candidate);
  const base = {
    candidate,
    sensitive: sensitivity.sensitive,
    sensitiveReasons: sensitivity.reasons,
  };

  if (candidate.class === "ignored") {
    return { ...base, outcome: "ignored", reason: "classified as chatter" };
  }

  if (sensitivity.sensitive) {
    const existing = (await args.reviewStore.list()).find(
      (item) => item.fingerprint === fingerprint,
    );
    const ref =
      existing?.id ??
      (await queue(args, `sensitive content (${sensitivity.reasons.join(", ")})`, true));
    return {
      ...base,
      outcome: "queued",
      reason: `sensitive: ${sensitivity.reasons.join(", ")}`,
      ref,
    };
  }

  if (candidate.class === "note") {
    const existing = (await args.reviewStore.list()).find(
      (item) => item.fingerprint === fingerprint,
    );
    if (existing) {
      return { ...base, outcome: "queued", reason: "duplicate review candidate", ref: existing.id };
    }
    const ref = await queue(args, "temporary note");
    return { ...base, outcome: "queued", reason: "temporary note held for review", ref };
  }

  if (candidate.confidence < AUTO_SAVE_THRESHOLD) {
    const existing = (await args.reviewStore.list()).find(
      (item) => item.fingerprint === fingerprint,
    );
    if (existing) {
      return { ...base, outcome: "queued", reason: "duplicate review candidate", ref: existing.id };
    }
    const ref = await queue(args, `low confidence (${candidate.confidence.toFixed(2)})`);
    return {
      ...base,
      outcome: "queued",
      reason: `low confidence ${candidate.confidence.toFixed(2)} < ${AUTO_SAVE_THRESHOLD}`,
      ref,
    };
  }

  if (candidate.class === "incident" && isResolution(candidate.content)) {
    const incidents = await args.memoryStore.findIncidentFactsForPaths({
      namespace: args.input.namespace,
      paths: candidate.paths,
    });
    const target = incidents[0];
    if (!target) {
      const ref = await queue(args, "incident resolution lacks a matching unresolved incident");
      return {
        ...base,
        outcome: "queued",
        reason: "resolution requires a matching unresolved incident",
        ref,
      };
    }
    await args.memoryStore.markIncidentResolved(target.id, fingerprint);
    return {
      ...base,
      outcome: "saved",
      reason: `resolved incident ${target.id}`,
      ref: target.id,
    };
  }

  const ref = await saveDurable(args);
  const superseded = candidate.content.match(/\bsupersedes\s+(fact_[a-z0-9]+)\b/i)?.[1];
  if (superseded && superseded !== ref) {
    try {
      await args.memoryStore.markFactSuperseded(superseded, ref);
    } catch {
      // A missing/invalid referenced fact does not invalidate the new decision.
    }
  }
  return { ...base, outcome: "saved", reason: `confident ${candidate.class} auto-saved`, ref };
}

async function saveDurable(args: {
  candidate: MemoryCandidate;
  input: ExtractionInput;
  memoryStore: MemoryFileStore;
  now: () => Date;
}): Promise<string> {
  const { candidate, input, memoryStore, now } = args;
  const fingerprint = candidateFingerprint(input.namespace, candidate);
  const existing = (await memoryStore.listFacts()).find(
    (fact) => fact.namespace === input.namespace && fact.fingerprint === fingerprint,
  );
  if (existing) return existing.id;
  const id = generateEntityId("fact");
  const isIncident = candidate.class === "incident";
  await memoryStore.writeFact({
    id,
    namespace: input.namespace,
    subject: candidate.subject,
    predicate: candidate.predicate,
    object: candidate.object,
    confidence: candidate.confidence,
    createdAt: now().toISOString(),
    createdByAgent: input.agentId ?? null,
    sourceInteractionId: null,
    sourceDeleted: false,
    content: candidate.content,
    category: isIncident ? "incident" : "general",
    paths: candidate.paths,
    severity: isIncident ? candidate.severity : null,
    fingerprint,
    sourcePlanId: input.planId ?? null,
    sourceSessionId: input.sessionId ?? null,
    verification: input.verification ?? [],
    introducedBy: isIncident ? (input.commitSha ?? null) : null,
  });
  return id;
}

async function queue(
  args: {
    candidate: MemoryCandidate;
    input: ExtractionInput;
    sensitivity: ReturnType<typeof scanSensitive>;
    reviewStore: ReviewStore;
    now: () => Date;
  },
  reason: string,
  redact = false,
): Promise<string> {
  const { candidate, input, sensitivity, reviewStore, now } = args;
  const fingerprint = candidateFingerprint(input.namespace, candidate);
  const id = generateEntityId("rev");
  await reviewStore.write({
    id,
    namespace: input.namespace,
    class: candidate.class,
    subject: candidate.subject,
    predicate: candidate.predicate,
    object: redact ? "[REDACTED SENSITIVE CONTENT]" : candidate.object,
    confidence: candidate.confidence,
    paths: candidate.paths,
    severity: candidate.severity,
    sensitive: sensitivity.sensitive,
    sensitiveReasons: sensitivity.reasons,
    reason,
    createdAt: now().toISOString(),
    createdByAgent: input.agentId ?? null,
    sourcePlanId: input.planId ?? null,
    fingerprint,
    sourceSessionId: input.sessionId ?? null,
    verification: input.verification ?? [],
    content: redact ? "[REDACTED SENSITIVE CONTENT]" : candidate.content,
  });
  await reviewStore.enforceLimit();
  return id;
}

function isResolution(content: string): boolean {
  return /\b(fixed|resolved|closed|no longer reproduces|verified the fix)\b/i.test(content);
}

export function candidateFingerprint(namespace: string, candidate: MemoryCandidate): string {
  const canonical = JSON.stringify({
    namespace: namespace.trim().toLowerCase(),
    class: candidate.class,
    subject: candidate.subject.trim().toLowerCase(),
    predicate: candidate.predicate.trim().toLowerCase(),
    object: candidate.object.trim().replace(/\s+/g, " ").toLowerCase(),
    content: candidate.content.trim().replace(/\s+/g, " ").toLowerCase(),
    paths: [...new Set(candidate.paths.map((path) => path.replace(/\\/g, "/")))].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Promote a queued review item to a durable fact and remove it from the queue.
 * Powers `codebuddy memory review approve`.
 */
export async function approveReviewItem(
  id: string,
  options: { repositoryRoot?: string; now?: () => Date } = {},
): Promise<string> {
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const now = options.now ?? (() => new Date());
  const reviewStore = new ReviewStore(repositoryRoot);
  const memoryStore = new MemoryFileStore(repositoryRoot);

  const item = await reviewStore.read(id);
  const factId = generateEntityId("fact");
  const isIncident = item.class === "incident";
  await memoryStore.writeFact({
    id: factId,
    namespace: item.namespace,
    subject: item.subject,
    predicate: item.predicate,
    object: item.object,
    confidence: item.confidence,
    createdAt: now().toISOString(),
    createdByAgent: item.createdByAgent,
    sourceInteractionId: null,
    sourceDeleted: false,
    content: item.content,
    category: isIncident ? "incident" : "general",
    paths: item.paths,
    severity: isIncident ? (item.severity ?? "medium") : null,
    fingerprint: item.fingerprint,
    sourcePlanId: item.sourcePlanId,
    sourceSessionId: item.sourceSessionId,
    verification: item.verification,
  });
  await reviewStore.delete(id);
  return factId;
}
