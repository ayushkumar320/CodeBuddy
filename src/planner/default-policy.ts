import type {
  ReadyEmbedding,
  RecentFact,
  RecentInteraction,
  RecentSummary,
} from "../core/repository.js";
import { countTokens } from "./budget.js";
import type {
  ConflictMode,
  ContextPolicy,
  PlanInput,
  PlannedContext,
  PlannedMessage,
  PlannerStats,
  SkipReason,
} from "./types.js";

type Candidate = {
  key: string;
  role: PlannedMessage["role"];
  content: string;
  tokens: number;
  score: number;
  source: "interaction" | "fact" | "summary";
  ownerId: string;
  createdAt: number;
  confidence: number;
  isRecencyFloor: boolean;
};

export type DefaultPolicyOptions = {
  recencyFloorSize?: number;
  embeddingCandidateLimit?: number;
  minVectorScore?: number;
};

export class DefaultPolicy implements ContextPolicy {
  private readonly recencyFloorSize: number;
  private readonly embeddingCandidateLimit: number;
  private readonly minVectorScore: number;

  constructor(options: DefaultPolicyOptions = {}) {
    this.recencyFloorSize = options.recencyFloorSize ?? 3;
    this.embeddingCandidateLimit = options.embeddingCandidateLimit ?? 256;
    this.minVectorScore = options.minVectorScore ?? 0.1;
  }

  async plan(input: PlanInput): Promise<PlannedContext> {
    const repo = input.repository;
    const counts = await repo.countEmbeddingStatuses(input.namespaceId);
    const useFallback = input.queryEmbedding === null || counts.ready === 0;

    const recencyInteractions = await repo.getRecentInteractions(
      input.namespaceId,
      input.sessionId,
      this.recencyFloorSize,
    );

    let candidates: Candidate[];
    let fallback: PlannerStats["fallback"] = "none";

    if (useFallback) {
      const summary = await repo.getLatestSummary(input.namespaceId, input.sessionId);
      const fallbackInteractions = await repo.getRecentInteractions(
        input.namespaceId,
        input.sessionId,
        Math.max(this.recencyFloorSize, 10),
      );
      candidates = this.buildFallbackCandidates(fallbackInteractions, summary);
      if (summary && fallbackInteractions.length > 0) fallback = "recency_summary";
      else if (summary) fallback = "summary";
      else fallback = "recency";
    } else {
      const ready = await repo.getReadyEmbeddings(input.namespaceId, this.embeddingCandidateLimit);
      const queryVector = input.queryEmbedding ?? [];
      const scored = this.scoreEmbeddings(ready, queryVector);
      const ownerIdsByType = groupOwnerIdsByType(scored);
      const [factRows, interactionRows, summaryRows] = await Promise.all([
        repo.getFactsByIds(input.namespaceId, ownerIdsByType.fact),
        repo.getInteractionsByIds(input.namespaceId, ownerIdsByType.interaction),
        repo.getSummariesByIds(input.namespaceId, ownerIdsByType.summary),
      ]);
      candidates = this.hydrateScored(scored, factRows, interactionRows, summaryRows);
      candidates = this.applyRecencyFloor(candidates, recencyInteractions);
    }

    candidates = this.applyConflictMode(candidates, input.conflictMode);
    candidates.sort((a, b) => {
      if (a.isRecencyFloor !== b.isRecencyFloor) return a.isRecencyFloor ? -1 : 1;
      return b.score - a.score;
    });

    const skipReasons: Partial<Record<SkipReason, number>> = {};
    const included: Candidate[] = [];
    let tokensUsed = 0;
    let itemsSkipped = 0;
    for (const candidate of candidates) {
      if (tokensUsed + candidate.tokens > input.budget) {
        bump(skipReasons, "budget_exhausted");
        itemsSkipped += 1;
        continue;
      }
      if (!candidate.isRecencyFloor && candidate.score < this.minVectorScore && !useFallback) {
        bump(skipReasons, "low_score");
        itemsSkipped += 1;
        continue;
      }
      included.push(candidate);
      tokensUsed += candidate.tokens;
    }

    const system = buildSystemPrompt(input.namespace, fallback, useFallback);
    const messages: PlannedMessage[] = included.map((candidate) => ({
      role: candidate.role,
      content: candidate.content,
    }));

    const stats: PlannerStats = {
      tokensUsed,
      itemsIncluded: included.length,
      itemsSkipped,
      budgetHeadroom: Math.max(0, input.budget - tokensUsed),
      fallback,
      skipReasons,
      embeddingCoverage: counts,
      budgetClamped: false,
    };

    return { system, messages, stats };
  }

  private scoreEmbeddings(
    rows: ReadyEmbedding[],
    queryVector: number[],
  ): Array<{ row: ReadyEmbedding; score: number }> {
    if (queryVector.length === 0) {
      return rows.map((row) => ({ row, score: 0 }));
    }
    return rows
      .map((row) => ({ row, score: cosine(row.vector, queryVector) }))
      .sort((a, b) => b.score - a.score);
  }

  private hydrateScored(
    scored: Array<{ row: ReadyEmbedding; score: number }>,
    factRows: RecentFact[],
    interactionRows: RecentInteraction[],
    summaryRows: RecentSummary[],
  ): Candidate[] {
    const factById = new Map(factRows.map((row) => [row.id, row] as const));
    const interactionById = new Map(interactionRows.map((row) => [row.id, row] as const));
    const summaryById = new Map(summaryRows.map((row) => [row.id, row] as const));

    const out: Candidate[] = [];
    for (const { row, score } of scored) {
      if (row.ownerType === "fact") {
        const fact = factById.get(row.ownerId);
        if (!fact || fact.sourceDeleted) continue;
        out.push({
          key: `fact:${fact.id}`,
          role: "system",
          content: fact.content,
          tokens: countTokens(fact.content),
          score,
          source: "fact",
          ownerId: fact.id,
          createdAt: fact.createdAt.getTime(),
          confidence: fact.confidence,
          isRecencyFloor: false,
        });
      } else if (row.ownerType === "interaction") {
        const interaction = interactionById.get(row.ownerId);
        if (!interaction) continue;
        out.push({
          key: `interaction:${interaction.id}`,
          role: "user",
          content: interaction.content,
          tokens: interaction.tokenCount || countTokens(interaction.content),
          score,
          source: "interaction",
          ownerId: interaction.id,
          createdAt: interaction.createdAt.getTime(),
          confidence: 1,
          isRecencyFloor: false,
        });
      } else {
        const summary = summaryById.get(row.ownerId);
        if (!summary) continue;
        out.push({
          key: `summary:${summary.id}`,
          role: "system",
          content: summary.content,
          tokens: summary.tokenCount || countTokens(summary.content),
          score,
          source: "summary",
          ownerId: summary.id,
          createdAt: summary.createdAt.getTime(),
          confidence: 1,
          isRecencyFloor: false,
        });
      }
    }
    return out;
  }

  private applyRecencyFloor(candidates: Candidate[], floor: RecentInteraction[]): Candidate[] {
    const byKey = new Map<string, Candidate>();
    for (const candidate of candidates) byKey.set(candidate.key, candidate);
    for (const row of floor) {
      const key = `interaction:${row.id}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.isRecencyFloor = true;
        continue;
      }
      byKey.set(key, {
        key,
        role: "user",
        content: row.content,
        tokens: row.tokenCount || countTokens(row.content),
        score: 1,
        source: "interaction",
        ownerId: row.id,
        createdAt: row.createdAt.getTime(),
        confidence: 1,
        isRecencyFloor: true,
      });
    }
    return Array.from(byKey.values());
  }

  private buildFallbackCandidates(
    interactions: RecentInteraction[],
    summary: RecentSummary | null,
  ): Candidate[] {
    const out: Candidate[] = [];
    if (summary) {
      out.push({
        key: `summary:${summary.id}`,
        role: "system",
        content: summary.content,
        tokens: summary.tokenCount || countTokens(summary.content),
        score: 1,
        source: "summary",
        ownerId: summary.id,
        createdAt: summary.createdAt.getTime(),
        confidence: 1,
        isRecencyFloor: true,
      });
    }
    for (const row of interactions) {
      out.push({
        key: `interaction:${row.id}`,
        role: "user",
        content: row.content,
        tokens: row.tokenCount || countTokens(row.content),
        score: 1,
        source: "interaction",
        ownerId: row.id,
        createdAt: row.createdAt.getTime(),
        confidence: 1,
        isRecencyFloor: true,
      });
    }
    return out;
  }

  private applyConflictMode(candidates: Candidate[], mode: ConflictMode): Candidate[] {
    if (mode === "all") return candidates;
    const facts = candidates.filter((c) => c.source === "fact");
    const others = candidates.filter((c) => c.source !== "fact");
    if (facts.length === 0) return candidates;
    const grouped = new Map<string, Candidate[]>();
    for (const fact of facts) {
      const bucket = grouped.get(fact.content.trim().toLowerCase()) ?? [];
      bucket.push(fact);
      grouped.set(fact.content.trim().toLowerCase(), bucket);
    }
    const survivors: Candidate[] = [];
    for (const bucket of grouped.values()) {
      if (bucket.length === 1) {
        const only = bucket[0];
        if (only) survivors.push(only);
        continue;
      }
      bucket.sort((a, b) => {
        if (mode === "latest") return b.createdAt - a.createdAt;
        return b.confidence - a.confidence;
      });
      const winner = bucket[0];
      if (winner) survivors.push(winner);
    }
    return [...others, ...survivors];
  }
}

function cosine(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function groupOwnerIdsByType(scored: Array<{ row: ReadyEmbedding }>): {
  fact: string[];
  interaction: string[];
  summary: string[];
} {
  const out = { fact: [] as string[], interaction: [] as string[], summary: [] as string[] };
  for (const { row } of scored) {
    out[row.ownerType].push(row.ownerId);
  }
  return out;
}

function bump(map: Partial<Record<SkipReason, number>>, key: SkipReason): void {
  map[key] = (map[key] ?? 0) + 1;
}

function buildSystemPrompt(
  namespace: string,
  fallback: PlannerStats["fallback"],
  isFallback: boolean,
): string {
  const base = `Memory context for namespace "${namespace}".`;
  if (isFallback) {
    return `${base} Fallback active (${fallback}); vector search unavailable or empty.`;
  }
  return base;
}
