import { generateEntityId } from "./ids.js";
import type {
  AgentWriteBreakdown,
  AuditEntry,
  EmbeddingJob,
  EmbeddingStatusSnapshot,
  FactCursor,
  FactInsert,
  InteractionInsert,
  ListedFact,
  ListedSummary,
  MemoryRepository,
  MemoryStats,
  ModelCallEntry,
  NamespaceRow,
  NamespaceSummary,
  PendingEmbeddingCounts,
  PendingEmbeddingInsert,
  ReadyEmbedding,
  RecentFact,
  RecentInteraction,
  RecentSummary,
  ShareWriteInput,
  SummaryInsert,
  VectorIndexHealth,
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
    const existing = this.summaries.get(input.summary.id);
    if (existing) {
      return {
        id: existing.id,
        embeddingId: "",
        sessionId: existing.sessionId,
        deduplicated: true,
      };
    }
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

  async getReadyEmbeddings(namespaceId: string, limit: number): Promise<ReadyEmbedding[]> {
    const ready: ReadyEmbedding[] = [];
    for (const row of this.embeddings.values()) {
      if (row.namespaceId !== namespaceId) continue;
      if (row.status !== "ready" || !row.vector) continue;
      ready.push({
        embeddingId: row.id,
        ownerType: row.ownerType,
        ownerId: row.ownerId,
        vector: row.vector,
        embeddingModel: row.embeddingModel,
      });
      if (ready.length >= limit) break;
    }
    return ready;
  }

  async getRecentInteractions(
    namespaceId: string,
    sessionId: string,
    limit: number,
  ): Promise<RecentInteraction[]> {
    const rows = Array.from(this.interactions.values())
      .filter((row) => row.namespaceId === namespaceId && row.sessionId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      content: row.content,
      tokenCount: row.tokenCount,
      createdAt: new Date(row.createdAt),
    }));
  }

  async getRecentFacts(namespaceId: string, limit: number): Promise<RecentFact[]> {
    const rows = Array.from(this.facts.values())
      .filter((row) => row.namespaceId === namespaceId && !row.sourceDeleted)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      confidence: 1,
      sourceDeleted: row.sourceDeleted,
      createdAt: new Date(row.createdAt),
    }));
  }

  async getLatestSummary(namespaceId: string, sessionId: string): Promise<RecentSummary | null> {
    const rows = Array.from(this.summaries.values())
      .filter((row) => row.namespaceId === namespaceId && row.sessionId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.sessionId,
      content: row.content,
      tokenCount: row.tokenCount,
      createdAt: new Date(row.createdAt),
    };
  }

  async getInteractionsByIds(namespaceId: string, ids: string[]): Promise<RecentInteraction[]> {
    const set = new Set(ids);
    return Array.from(this.interactions.values())
      .filter((row) => row.namespaceId === namespaceId && set.has(row.id))
      .map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        content: row.content,
        tokenCount: row.tokenCount,
        createdAt: new Date(row.createdAt),
      }));
  }

  async getFactsByIds(namespaceId: string, ids: string[]): Promise<RecentFact[]> {
    const set = new Set(ids);
    return Array.from(this.facts.values())
      .filter((row) => row.namespaceId === namespaceId && set.has(row.id))
      .map((row) => ({
        id: row.id,
        content: row.content,
        confidence: 1,
        sourceInteractionId: row.sourceInteractionId ?? null,
        sourceDeleted: row.sourceDeleted,
        createdAt: new Date(row.createdAt),
      }));
  }

  async getSummariesByIds(namespaceId: string, ids: string[]): Promise<RecentSummary[]> {
    const set = new Set(ids);
    return Array.from(this.summaries.values())
      .filter((row) => row.namespaceId === namespaceId && set.has(row.id))
      .map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        content: row.content,
        tokenCount: row.tokenCount,
        createdAt: new Date(row.createdAt),
      }));
  }

  async countEmbeddingStatuses(namespaceId: string): Promise<PendingEmbeddingCounts> {
    let pending = 0;
    let failed = 0;
    let ready = 0;
    for (const row of this.embeddings.values()) {
      if (row.namespaceId !== namespaceId) continue;
      if (row.status === "pending") pending += 1;
      else if (row.status === "failed") failed += 1;
      else if (row.status === "ready") ready += 1;
    }
    return { pending, failed, ready };
  }

  async listFacts(input: {
    namespaceId: string;
    subject?: string;
    limit: number;
    cursor?: FactCursor;
  }): Promise<ListedFact[]> {
    const cursorTime = input.cursor?.createdAt.getTime();
    return Array.from(this.facts.values())
      .filter((row) => row.namespaceId === input.namespaceId && !row.sourceDeleted)
      .filter((row) => !input.subject || row.subject === input.subject)
      .filter((row) => {
        if (!input.cursor || cursorTime === undefined) return true;
        if (row.createdAt < cursorTime) return true;
        return row.createdAt === cursorTime && row.id < input.cursor.id;
      })
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .slice(0, input.limit)
      .map((row) => ({
        id: row.id,
        subject: row.subject,
        predicate: row.predicate,
        object: row.object,
        content: row.content,
        confidence: 1,
        sourceInteractionId: row.sourceInteractionId ?? null,
        sourceDeleted: row.sourceDeleted,
        createdByAgent: row.createdByAgent ?? null,
        createdAt: new Date(row.createdAt),
      }));
  }

  async listSummaries(input: { namespaceId: string; limit: number }): Promise<ListedSummary[]> {
    return Array.from(this.summaries.values())
      .filter((row) => row.namespaceId === input.namespaceId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, input.limit)
      .map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        content: row.content,
        version: row.version ?? 1,
        tokenCount: row.tokenCount,
        createdByAgent: row.createdByAgent ?? null,
        createdAt: new Date(row.createdAt),
      }));
  }

  async listNamespaces(): Promise<NamespaceSummary[]> {
    return Array.from(this.namespaces.values())
      .map((namespace) => {
        const namespaceFacts = Array.from(this.facts.values()).filter(
          (row) => row.namespaceId === namespace.id && !row.sourceDeleted,
        );
        const activity = [
          ...namespaceFacts.map((row) => row.createdAt),
          ...Array.from(this.interactions.values())
            .filter((row) => row.namespaceId === namespace.id)
            .map((row) => row.createdAt),
          ...Array.from(this.summaries.values())
            .filter((row) => row.namespaceId === namespace.id)
            .map((row) => row.createdAt),
        ];
        return {
          name: namespace.name,
          factCount: namespaceFacts.length,
          lastActivity: activity.length ? new Date(Math.max(...activity)) : null,
        };
      })
      .sort((a, b) => (b.lastActivity?.getTime() ?? 0) - (a.lastActivity?.getTime() ?? 0));
  }

  async getAgentWriteBreakdown(namespaceId?: string): Promise<AgentWriteBreakdown[]> {
    const counts = new Map<string, { agentId: string | null; writes: number }>();
    const add = (agentId: string | undefined, ns: string) => {
      if (namespaceId && ns !== namespaceId) return;
      const key = agentId ?? "__null__";
      const current = counts.get(key) ?? { agentId: agentId ?? null, writes: 0 };
      current.writes += 1;
      counts.set(key, current);
    };
    for (const row of this.interactions.values()) add(row.createdByAgent, row.namespaceId);
    for (const row of this.facts.values()) add(row.createdByAgent, row.namespaceId);
    for (const row of this.summaries.values()) add(row.createdByAgent, row.namespaceId);
    return Array.from(counts.values()).sort((a, b) => b.writes - a.writes);
  }

  async getStats(namespaceId?: string): Promise<MemoryStats> {
    const embeddings = { pending: 0, failed: 0, ready: 0 };
    const inScope = (ns: string) => !namespaceId || ns === namespaceId;
    for (const row of this.embeddings.values()) {
      if (!inScope(row.namespaceId)) continue;
      if (row.status === "pending") embeddings.pending += 1;
      if (row.status === "failed") embeddings.failed += 1;
      if (row.status === "ready") embeddings.ready += 1;
    }
    const now = Date.now();
    const calls = this.modelCalls.filter(
      (entry) => !namespaceId || entry.namespaceId === namespaceId,
    );
    return {
      namespaces: this.namespaces.size,
      interactions: Array.from(this.interactions.values()).filter((row) => inScope(row.namespaceId))
        .length,
      facts: Array.from(this.facts.values()).filter((row) => inScope(row.namespaceId)).length,
      summaries: Array.from(this.summaries.values()).filter((row) => inScope(row.namespaceId))
        .length,
      embeddings,
      modelCalls: {
        last60s: calls.filter((entry) => now - Number(entry.metadata.latencyMs ?? 0) <= 60_000)
          .length,
        lastHour: calls.length,
        last24h: calls.length,
        gatedFailures: calls.filter((entry) => entry.metadata.status === "gated").length,
      },
    };
  }

  async pruneBefore(
    cutoff: Date,
  ): Promise<{ interactions: number; facts: number; summaries: number }> {
    const before = cutoff.getTime();
    let interactionsDeleted = 0;
    let factsDeleted = 0;
    let summariesDeleted = 0;
    for (const [id, row] of this.interactions) {
      if (row.createdAt < before) {
        this.interactions.delete(id);
        interactionsDeleted += 1;
      }
    }
    for (const [id, row] of this.facts) {
      if (row.createdAt < before) {
        this.facts.delete(id);
        factsDeleted += 1;
      }
    }
    for (const [id, row] of this.summaries) {
      if (row.createdAt < before) {
        this.summaries.delete(id);
        summariesDeleted += 1;
      }
    }
    return { interactions: interactionsDeleted, facts: factsDeleted, summaries: summariesDeleted };
  }

  async getVectorIndexHealth(namespaceId?: string): Promise<VectorIndexHealth> {
    const vectorCount = Array.from(this.embeddings.values()).filter(
      (row) => !namespaceId || row.namespaceId === namespaceId,
    ).length;
    return {
      vectorCount,
      indexName: "in_memory",
      indexDefinition: null,
      needsTuning: vectorCount >= 100_000,
    };
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
