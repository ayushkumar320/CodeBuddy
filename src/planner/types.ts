import type { MemoryRepository } from "../core/repository.js";

export type ConflictMode = "all" | "latest" | "highest_confidence";

export type PlanInput = {
  namespace: string;
  namespaceId: string;
  sessionId: string;
  query: string;
  budget: number;
  callerModel?: string | undefined;
  conflictMode: ConflictMode;
  queryEmbedding: number[] | null;
  repository: MemoryRepository;
};

export type PlannedMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type SkipReason =
  | "budget_exhausted"
  | "low_score"
  | "duplicate"
  | "superseded"
  | "source_deleted";

export type PlannerStats = {
  tokensUsed: number;
  itemsIncluded: number;
  itemsSkipped: number;
  budgetHeadroom: number;
  fallback: "none" | "recency" | "summary" | "recency_summary";
  skipReasons: Partial<Record<SkipReason, number>>;
  embeddingCoverage: {
    ready: number;
    pending: number;
    failed: number;
  };
  budgetClamped: boolean;
  budgetClampReason?: string;
};

export type PlannedContext = {
  system: string;
  messages: PlannedMessage[];
  stats: PlannerStats;
};

export type ContextPolicy = {
  plan(input: PlanInput): Promise<PlannedContext>;
};
