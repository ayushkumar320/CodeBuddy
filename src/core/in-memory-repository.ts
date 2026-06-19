import { generateEntityId } from "./ids.js";
import type {
  AuditEntry,
  EmbeddingJob,
  EmbeddingStatusSnapshot,
  FactInsert,
  InteractionInsert,
  MemoryRepository,
  ModelCallEntry,
  NamespaceRow,
  PendingEmbeddingInsert,
  ShareWriteInput,
  SummaryInsert,
  WriteResult,
} from "./repository.js";
import type { EmbeddingJobStatus, MemoryWriteType } from "./types.js";

type StoredInteraction = InteractionInsert & { createdAt: number };
type StoredFact = FactInsert & {
  createdAt: number;
  sourceDeleted: boolean;
};
type StoredSummary = SummaryInsert & { createdAt: number };

type StoredEmbedding = {
  id: string;
  namespaceId: string;
  ownerType: MemoryWriteType;
  ownerId: string;
  embeddingModel: string;
  status: EmbeddingJobStatus;
  attempts: number;
  lastError: string | null;
  vector: number[] | null;
  claimedAt: number | null;
  content: string;
};

type StoredShare = ShareWriteInput & { tombstoned: boolean };

export class InMemoryMemoryRepository implements MemoryRepository {
  readonly namespaces = new Map<string, NamespaceRow>();
  readonly interactions = new Map<string, StoredInteraction>();
  readonly facts = new Map<string, StoredFact>();
  readonly summaries = new Map<string, StoredSummary>();
  readonly embeddings = new Map<string, StoredEmbedding>();
  readonly shares = new Map<string, StoredShare>();
  readonly auditLog: AuditEntry[] = [];
  readonly modelCalls: ModelCallEntry[] = [];
  private readonly locks = new Map<string, Promise<unknown>>();

  async ensureNamespace(name: string): Promise<NamespaceRow> {
    for (const ns of this.namespaces.values()) {
      if (ns.name === name) return ns;
    }
    const row: NamespaceRow = { id: generateEntityId("ns"), name };
    this.namespaces.set(row.id, row);
    return row;
  }

  async getNamespaceByName(name: string): Promise<NamespaceRow | null> {
    for (const ns of this.namespaces.values()) {
      if (ns.name === name) return ns;
    }
    return null;
  }

  async withSessionLock<T>(
    namespaceId: string,
    sessionId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = `${namespaceId}\x1f${sessionId}`;
    const prior = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prior.then(() => gate);
    this.locks.set(key, chained);
    try {
      await prior;
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === chained) {
        this.locks.delete(key);
      }
    }
  }

  async writeInteraction(input: {
    interaction: InteractionInsert;
    embedding: PendingEmbeddingInsert;
    audit: AuditEntry;
  }): Promise<WriteResult> {
    for (const existing of this.interactions.values()) {
      if (
        existing.namespaceId === input.interaction.namespaceId &&
        existing.contentHash === input.interaction.contentHash
      ) {
        return {
          id: existing.id,
          embeddingId: this.findEmbeddingByOwner(existing.id)?.id ?? "",
          sessionId: existing.sessionId,
          deduplicated: true,
        };
      }
    }
    this.interactions.set(input.interaction.id, {
      ...input.interaction,
      createdAt: Date.now(),
    });
    this.insertPendingEmbedding(input.embedding, input.interaction.content);
    this.auditLog.push(input.audit);
    return {
      id: input.interaction.id,
      embeddingId: input.embedding.id,
      sessionId: input.interaction.sessionId,
      deduplicated: false,
    };
  }

  async writeFact(input: {
    fact: FactInsert;
    embedding: PendingEmbeddingInsert;
    audit: AuditEntry;
  }): Promise<WriteResult> {
    for (const existing of this.facts.values()) {
      if (
        existing.namespaceId === input.fact.namespaceId &&
        existing.contentHash === input.fact.contentHash
      ) {
        return {
          id: existing.id,
          embeddingId: this.findEmbeddingByOwner(existing.id)?.id ?? "",
          sessionId: "",
          deduplicated: true,
        };
      }
    }
    this.facts.set(input.fact.id, {
      ...input.fact,
      sourceDeleted: false,
      createdAt: Date.now(),
    });
    this.insertPendingEmbedding(input.embedding, input.fact.content);
    this.auditLog.push(input.audit);
    return {
      id: input.fact.id,
      embeddingId: input.embedding.id,
      sessionId: "",
      deduplicated: false,
    };
  }

  async writeSummary(input: {
    summary: SummaryInsert;
    embedding: PendingEmbeddingInsert;
    audit: AuditEntry;
  }): Promise<WriteResult> {
    this.summaries.set(input.summary.id, {
      ...input.summary,
      createdAt: Date.now(),
    });
    this.insertPendingEmbedding(input.embedding, input.summary.content);
    this.auditLog.push(input.audit);
    return {
      id: input.summary.id,
      embeddingId: input.embedding.id,
      sessionId: input.summary.sessionId,
      deduplicated: false,
    };
  }

  async claimPendingEmbeddings(limit: number): Promise<EmbeddingJob[]> {
    const now = Date.now();
    const claimed: EmbeddingJob[] = [];
    for (const row of this.embeddings.values()) {
      if (claimed.length >= limit) break;
      if (row.status !== "pending") continue;
      if (row.claimedAt && now - row.claimedAt < 1_000) continue;
      row.claimedAt = now;
      claimed.push({
        id: row.id,
        namespaceId: row.namespaceId,
        ownerType: row.ownerType,
        ownerId: row.ownerId,
        embeddingModel: row.embeddingModel,
        attempts: row.attempts,
        content: row.content,
      });
    }
    return claimed;
  }

  async markEmbeddingReady(id: string, vector: number[], model: string): Promise<void> {
    const row = this.embeddings.get(id);
    if (!row) return;
    row.status = "ready";
    row.vector = vector;
    row.embeddingModel = model;
    row.lastError = null;
    row.claimedAt = null;
  }

  async markEmbeddingFailed(id: string, error: string, attempts: number): Promise<void> {
    const row = this.embeddings.get(id);
    if (!row) return;
    row.attempts = attempts;
    row.lastError = error;
    row.claimedAt = null;
    row.status = attempts >= 5 ? "failed" : "pending";
  }

  async getEmbeddingStatus(id: string): Promise<EmbeddingStatusSnapshot | null> {
    const row = this.embeddings.get(id);
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      attempts: row.attempts,
      lastError: row.lastError,
    };
  }

  async shareReference(input: ShareWriteInput): Promise<void> {
    this.shares.set(input.id, { ...input, tombstoned: false });
  }

  async shareSnapshot(input: {
    share: ShareWriteInput;
    snapshotFact: FactInsert;
    embedding: PendingEmbeddingInsert;
  }): Promise<void> {
    this.facts.set(input.snapshotFact.id, {
      ...input.snapshotFact,
      sourceDeleted: false,
      createdAt: Date.now(),
    });
    this.insertPendingEmbedding(input.embedding, input.snapshotFact.content);
    this.shares.set(input.share.id, { ...input.share, tombstoned: false });
  }

  async forgetInteraction(id: string, audit: AuditEntry): Promise<{ found: boolean }> {
    const existing = this.interactions.get(id);
    if (!existing) return { found: false };
    this.interactions.delete(id);
    for (const [embeddingId, row] of this.embeddings) {
      if (row.ownerType === "interaction" && row.ownerId === id) {
        this.embeddings.delete(embeddingId);
      }
    }
    for (const fact of this.facts.values()) {
      if (fact.sourceInteractionId === id) {
        fact.sourceDeleted = true;
      }
    }
    this.auditLog.push(audit);
    return { found: true };
  }

  async forgetFact(id: string, audit: AuditEntry): Promise<{ found: boolean }> {
    const existing = this.facts.get(id);
    if (!existing) return { found: false };
    this.facts.delete(id);
    for (const [embeddingId, row] of this.embeddings) {
      if (row.ownerType === "fact" && row.ownerId === id) {
        this.embeddings.delete(embeddingId);
      }
    }
    for (const share of this.shares.values()) {
      if (share.sourceFactId === id && share.mode === "reference") {
        share.tombstoned = true;
      }
    }
    this.auditLog.push(audit);
    return { found: true };
  }

  async recordModelCall(entry: ModelCallEntry): Promise<void> {
    this.modelCalls.push(entry);
  }

  async recordAudit(entry: AuditEntry): Promise<void> {
    this.auditLog.push(entry);
  }

  private insertPendingEmbedding(input: PendingEmbeddingInsert, content: string): void {
    this.embeddings.set(input.id, {
      id: input.id,
      namespaceId: input.namespaceId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      embeddingModel: input.embeddingModel,
      status: "pending",
      attempts: 0,
      lastError: null,
      vector: null,
      claimedAt: null,
      content,
    });
  }

  private findEmbeddingByOwner(ownerId: string): StoredEmbedding | undefined {
    for (const row of this.embeddings.values()) {
      if (row.ownerId === ownerId) return row;
    }
    return undefined;
  }
}
