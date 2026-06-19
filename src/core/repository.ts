import type { ProviderCallMetadata } from "../providers/adapter.js";
import type { AuditAction, EmbeddingJobStatus, MemoryWriteType } from "./types.js";

export type NamespaceRow = {
  id: string;
  name: string;
};

export type InteractionInsert = {
  id: string;
  namespaceId: string;
  sessionId: string;
  content: string;
  contentHash: string;
  tokenCount: number;
  createdByAgent?: string | undefined;
};

export type FactInsert = {
  id: string;
  namespaceId: string;
  content: string;
  contentHash: string;
  subject: string;
  predicate: string;
  object: string;
  sourceInteractionId?: string | undefined;
  createdByAgent?: string | undefined;
};

export type SummaryInsert = {
  id: string;
  namespaceId: string;
  sessionId: string;
  content: string;
  tokenCount: number;
  createdByAgent?: string | undefined;
};

export type PendingEmbeddingInsert = {
  id: string;
  namespaceId: string;
  ownerType: MemoryWriteType;
  ownerId: string;
  embeddingModel: string;
};

export type EmbeddingJob = {
  id: string;
  namespaceId: string;
  ownerType: MemoryWriteType;
  ownerId: string;
  embeddingModel: string;
  attempts: number;
  content: string;
};

export type WriteResult = {
  id: string;
  embeddingId: string;
  sessionId: string;
  deduplicated: boolean;
};

export type AuditEntry = {
  id: string;
  namespaceId: string;
  action: AuditAction;
  entityType: string;
  entityId?: string | undefined;
  createdByAgent?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type ModelCallEntry = {
  id: string;
  namespaceId?: string | undefined;
  metadata: ProviderCallMetadata;
};

export type ShareWriteInput = {
  id: string;
  fromNamespaceId: string;
  toNamespaceId: string;
  sourceFactId: string;
  mode: "reference" | "snapshot";
  snapshotFactId?: string | undefined;
  createdByAgent?: string | undefined;
};

export type EmbeddingStatusSnapshot = {
  id: string;
  status: EmbeddingJobStatus;
  attempts: number;
  lastError: string | null;
};

export type MemoryRepository = {
  ensureNamespace(name: string): Promise<NamespaceRow>;
  getNamespaceByName(name: string): Promise<NamespaceRow | null>;

  withSessionLock<T>(namespaceId: string, sessionId: string, fn: () => Promise<T>): Promise<T>;

  writeInteraction(input: {
    interaction: InteractionInsert;
    embedding: PendingEmbeddingInsert;
    audit: AuditEntry;
  }): Promise<WriteResult>;

  writeFact(input: {
    fact: FactInsert;
    embedding: PendingEmbeddingInsert;
    audit: AuditEntry;
  }): Promise<WriteResult>;

  writeSummary(input: {
    summary: SummaryInsert;
    embedding: PendingEmbeddingInsert;
    audit: AuditEntry;
  }): Promise<WriteResult>;

  claimPendingEmbeddings(limit: number): Promise<EmbeddingJob[]>;
  markEmbeddingReady(id: string, vector: number[], model: string): Promise<void>;
  markEmbeddingFailed(id: string, error: string, attempts: number): Promise<void>;
  getEmbeddingStatus(id: string): Promise<EmbeddingStatusSnapshot | null>;

  shareReference(input: ShareWriteInput): Promise<void>;
  shareSnapshot(input: {
    share: ShareWriteInput;
    snapshotFact: FactInsert;
    embedding: PendingEmbeddingInsert;
  }): Promise<void>;

  forgetInteraction(id: string, audit: AuditEntry): Promise<{ found: boolean }>;
  forgetFact(id: string, audit: AuditEntry): Promise<{ found: boolean }>;

  recordModelCall(entry: ModelCallEntry): Promise<void>;
  recordAudit(entry: AuditEntry): Promise<void>;
};
