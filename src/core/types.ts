import type { PlannedContext } from "../planner/types.js";

export type ProviderConfig = {
  type: "huggingface";
  apiKey?: string;
};

export type WorkerConfig = {
  pollIntervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
};

export type CodeBuddyConfig = {
  postgresUrl: string;
  provider: ProviderConfig;
  namespace: string;
  projectRoot?: string;
  tokenBudget?: number;
  worker?: WorkerConfig;
};

export type CodeBuddyStatus = {
  ready: boolean;
  phase: "foundation" | "storage" | "runtime";
  message: string;
  namespaceId: string;
};

export type MemoryWriteType = "interaction" | "fact" | "summary";

export type RememberInput = {
  sessionId?: string;
  content: string;
  type?: MemoryWriteType;
  idempotencyKey?: string;
  agentId?: string;
};

export type RememberBatchItem = RememberInput;

export type RememberResult = {
  id: string;
  sessionId: string;
  deduplicated: boolean;
};

export type RecallInput = {
  sessionId: string;
  query: string;
  budget?: number;
  callerModel?: string;
  conflictMode?: "all" | "latest" | "highest_confidence";
};

export type RecallResult = PlannedContext;

export type ShareInput = {
  from: string;
  to: string;
  factIds: string[];
  mode?: "reference" | "snapshot";
  agentId?: string;
};

export type ShareResult = {
  shared: number;
};

export type ForgetResult = {
  ok: boolean;
  entityType: "interaction" | "fact" | "unknown";
};

export type EmbeddingJobStatus = "pending" | "ready" | "failed";

export type AuditAction = "remember" | "remember_batch" | "share" | "forget" | "config";
