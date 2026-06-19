import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { generateEntityId } from "../core/ids.js";
import type {
  AuditEntry,
  EmbeddingJob,
  EmbeddingStatusSnapshot,
  FactInsert,
  InteractionInsert,
  MemoryRepository,
  ModelCallEntry,
  NamespaceRow,
  PendingEmbeddingCounts,
  PendingEmbeddingInsert,
  ReadyEmbedding,
  RecentFact,
  RecentInteraction,
  RecentSummary,
  ShareWriteInput,
  SummaryInsert,
  WriteResult,
} from "../core/repository.js";
import type { DatabaseClient } from "./client.js";
import {
  auditLog,
  embeddings,
  facts,
  interactions,
  modelCalls,
  namespaces,
  sessionSummaries,
  shares,
} from "./schema.js";

type Db = DatabaseClient["db"];

export class PostgresMemoryRepository implements MemoryRepository {
  private readonly client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.client = client;
  }

  private get db(): Db {
    return this.client.db;
  }

  async ensureNamespace(name: string): Promise<NamespaceRow> {
    const existing = await this.getNamespaceByName(name);
    if (existing) return existing;
    const id = generateEntityId("ns");
    await this.db
      .insert(namespaces)
      .values({ id, name })
      .onConflictDoNothing({ target: namespaces.name });
    const row = await this.getNamespaceByName(name);
    if (!row) throw new Error(`Failed to ensure namespace ${name}.`);
    return row;
  }

  async getNamespaceByName(name: string): Promise<NamespaceRow | null> {
    const rows = await this.db
      .select({ id: namespaces.id, name: namespaces.name })
      .from(namespaces)
      .where(eq(namespaces.name, name))
      .limit(1);
    return rows[0] ?? null;
  }

  async withSessionLock<T>(
    namespaceId: string,
    sessionId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const [k1, k2] = advisoryLockKeys(namespaceId, sessionId);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${k1}, ${k2})`);
      return fn();
    });
  }

  async writeInteraction(input: {
    interaction: InteractionInsert;
    embedding: PendingEmbeddingInsert;
    audit: AuditEntry;
  }): Promise<WriteResult> {
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: interactions.id, sessionId: interactions.sessionId })
        .from(interactions)
        .where(
          and(
            eq(interactions.namespaceId, input.interaction.namespaceId),
            eq(interactions.contentHash, input.interaction.contentHash),
          ),
        )
        .limit(1);
      const existingRow = existing[0];
      if (existingRow) {
        return {
          id: existingRow.id,
          embeddingId: "",
          sessionId: existingRow.sessionId,
          deduplicated: true,
        };
      }
      await tx.insert(interactions).values({
        id: input.interaction.id,
        namespaceId: input.interaction.namespaceId,
        sessionId: input.interaction.sessionId,
        content: input.interaction.content,
        contentHash: input.interaction.contentHash,
        tokenCount: input.interaction.tokenCount,
        createdByAgent: input.interaction.createdByAgent ?? null,
      });
      await tx.insert(embeddings).values({
        id: input.embedding.id,
        namespaceId: input.embedding.namespaceId,
        ownerType: input.embedding.ownerType,
        ownerId: input.embedding.ownerId,
        vector: zeroVectorLiteral(),
        embeddingModel: input.embedding.embeddingModel,
        status: "pending",
      });
      await tx.insert(auditLog).values(toAuditRow(input.audit));
      return {
        id: input.interaction.id,
        embeddingId: input.embedding.id,
        sessionId: input.interaction.sessionId,
        deduplicated: false,
      };
    });
  }

  async writeFact(input: {
    fact: FactInsert;
    embedding: PendingEmbeddingInsert;
    audit: AuditEntry;
  }): Promise<WriteResult> {
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: facts.id })
        .from(facts)
        .where(
          and(
            eq(facts.namespaceId, input.fact.namespaceId),
            eq(facts.contentHash, input.fact.contentHash),
          ),
        )
        .limit(1);
      const existingRow = existing[0];
      if (existingRow) {
        return {
          id: existingRow.id,
          embeddingId: "",
          sessionId: "",
          deduplicated: true,
        };
      }
      await tx.insert(facts).values({
        id: input.fact.id,
        namespaceId: input.fact.namespaceId,
        subject: input.fact.subject,
        predicate: input.fact.predicate,
        object: input.fact.object,
        content: input.fact.content,
        contentHash: input.fact.contentHash,
        sourceInteractionId: input.fact.sourceInteractionId ?? null,
        createdByAgent: input.fact.createdByAgent ?? null,
      });
      await tx.insert(embeddings).values({
        id: input.embedding.id,
        namespaceId: input.embedding.namespaceId,
        ownerType: input.embedding.ownerType,
        ownerId: input.embedding.ownerId,
        vector: zeroVectorLiteral(),
        embeddingModel: input.embedding.embeddingModel,
        status: "pending",
      });
      await tx.insert(auditLog).values(toAuditRow(input.audit));
      return {
        id: input.fact.id,
        embeddingId: input.embedding.id,
        sessionId: "",
        deduplicated: false,
      };
    });
  }

  async writeSummary(input: {
    summary: SummaryInsert;
    embedding: PendingEmbeddingInsert;
    audit: AuditEntry;
  }): Promise<WriteResult> {
    return this.db.transaction(async (tx) => {
      await tx.insert(sessionSummaries).values({
        id: input.summary.id,
        namespaceId: input.summary.namespaceId,
        sessionId: input.summary.sessionId,
        content: input.summary.content,
        tokenCount: input.summary.tokenCount,
        createdByAgent: input.summary.createdByAgent ?? null,
      });
      await tx.insert(embeddings).values({
        id: input.embedding.id,
        namespaceId: input.embedding.namespaceId,
        ownerType: input.embedding.ownerType,
        ownerId: input.embedding.ownerId,
        vector: zeroVectorLiteral(),
        embeddingModel: input.embedding.embeddingModel,
        status: "pending",
      });
      await tx.insert(auditLog).values(toAuditRow(input.audit));
      return {
        id: input.summary.id,
        embeddingId: input.embedding.id,
        sessionId: input.summary.sessionId,
        deduplicated: false,
      };
    });
  }

  async claimPendingEmbeddings(limit: number): Promise<EmbeddingJob[]> {
    const rows = await this.client.sql<
      {
        id: string;
        namespace_id: string;
        owner_type: "interaction" | "fact" | "summary";
        owner_id: string;
        embedding_model: string;
        attempts: number;
        content: string;
      }[]
    >`
      with claimed as (
        select id from embeddings
        where status = 'pending'
        order by created_at asc
        for update skip locked
        limit ${limit}
      )
      update embeddings e
      set updated_at = now()
      from claimed
      where e.id = claimed.id
      returning
        e.id,
        e.namespace_id,
        e.owner_type,
        e.owner_id,
        e.embedding_model,
        e.attempts,
        coalesce(
          (select content from interactions where id = e.owner_id),
          (select content from facts where id = e.owner_id),
          (select content from session_summaries where id = e.owner_id)
        ) as content
    `;
    return rows.map((row) => ({
      id: row.id,
      namespaceId: row.namespace_id,
      ownerType: row.owner_type,
      ownerId: row.owner_id,
      embeddingModel: row.embedding_model,
      attempts: row.attempts,
      content: row.content ?? "",
    }));
  }

  async markEmbeddingReady(id: string, vector: number[], model: string): Promise<void> {
    const literal = `[${vector.join(",")}]`;
    await this.db
      .update(embeddings)
      .set({
        status: "ready",
        vector: literal,
        embeddingModel: model,
        lastError: null,
        updatedAt: sql`now()`,
      })
      .where(eq(embeddings.id, id));
  }

  async markEmbeddingFailed(id: string, error: string, attempts: number): Promise<void> {
    await this.db
      .update(embeddings)
      .set({
        status: sql`case when ${attempts} >= 5 then 'failed'::embedding_status else 'pending'::embedding_status end`,
        attempts,
        lastError: error,
        updatedAt: sql`now()`,
      })
      .where(eq(embeddings.id, id));
  }

  async getEmbeddingStatus(id: string): Promise<EmbeddingStatusSnapshot | null> {
    const rows = await this.db
      .select({
        id: embeddings.id,
        status: embeddings.status,
        attempts: embeddings.attempts,
        lastError: embeddings.lastError,
      })
      .from(embeddings)
      .where(eq(embeddings.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      attempts: row.attempts,
      lastError: row.lastError,
    };
  }

  async shareReference(input: ShareWriteInput): Promise<void> {
    await this.db.insert(shares).values({
      id: input.id,
      fromNamespaceId: input.fromNamespaceId,
      toNamespaceId: input.toNamespaceId,
      sourceFactId: input.sourceFactId,
      mode: "reference",
      createdByAgent: input.createdByAgent ?? null,
    });
  }

  async shareSnapshot(input: {
    share: ShareWriteInput;
    snapshotFact: FactInsert;
    embedding: PendingEmbeddingInsert;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(facts).values({
        id: input.snapshotFact.id,
        namespaceId: input.snapshotFact.namespaceId,
        subject: input.snapshotFact.subject,
        predicate: input.snapshotFact.predicate,
        object: input.snapshotFact.object,
        content: input.snapshotFact.content,
        contentHash: input.snapshotFact.contentHash,
        sourceInteractionId: input.snapshotFact.sourceInteractionId ?? null,
        createdByAgent: input.snapshotFact.createdByAgent ?? null,
      });
      await tx.insert(embeddings).values({
        id: input.embedding.id,
        namespaceId: input.embedding.namespaceId,
        ownerType: input.embedding.ownerType,
        ownerId: input.embedding.ownerId,
        vector: zeroVectorLiteral(),
        embeddingModel: input.embedding.embeddingModel,
        status: "pending",
      });
      await tx.insert(shares).values({
        id: input.share.id,
        fromNamespaceId: input.share.fromNamespaceId,
        toNamespaceId: input.share.toNamespaceId,
        sourceFactId: input.share.sourceFactId,
        snapshotFactId: input.share.snapshotFactId ?? null,
        mode: "snapshot",
        createdByAgent: input.share.createdByAgent ?? null,
      });
    });
  }

  async forgetInteraction(id: string, audit: AuditEntry): Promise<{ found: boolean }> {
    return this.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(interactions)
        .where(eq(interactions.id, id))
        .returning({ id: interactions.id });
      if (deleted.length === 0) return { found: false };
      await tx
        .delete(embeddings)
        .where(and(eq(embeddings.ownerType, "interaction"), eq(embeddings.ownerId, id)));
      await tx.update(facts).set({ sourceDeleted: true }).where(eq(facts.sourceInteractionId, id));
      await tx.insert(auditLog).values(toAuditRow(audit));
      return { found: true };
    });
  }

  async forgetFact(id: string, audit: AuditEntry): Promise<{ found: boolean }> {
    return this.db.transaction(async (tx) => {
      const deleted = await tx.delete(facts).where(eq(facts.id, id)).returning({ id: facts.id });
      if (deleted.length === 0) return { found: false };
      await tx
        .delete(embeddings)
        .where(and(eq(embeddings.ownerType, "fact"), eq(embeddings.ownerId, id)));
      await tx
        .update(shares)
        .set({ tombstoned: true })
        .where(and(eq(shares.sourceFactId, id), eq(shares.mode, "reference")));
      await tx.insert(auditLog).values(toAuditRow(audit));
      return { found: true };
    });
  }

  async recordModelCall(entry: ModelCallEntry): Promise<void> {
    await this.db.insert(modelCalls).values({
      id: entry.id,
      namespaceId: entry.namespaceId ?? null,
      model: entry.metadata.model,
      type: entry.metadata.type,
      latencyMs: entry.metadata.latencyMs,
      tokens: entry.metadata.tokens ?? null,
      status: entry.metadata.status,
      error: entry.metadata.error ?? null,
      metadata: {
        retries: entry.metadata.retries,
        fallbackTriggered: entry.metadata.fallbackTriggered,
        coldStartWaitMs: entry.metadata.coldStartWaitMs,
      },
    });
  }

  async recordAudit(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLog).values(toAuditRow(entry));
  }

  async getReadyEmbeddings(namespaceId: string, limit: number): Promise<ReadyEmbedding[]> {
    const rows = await this.client.sql<
      {
        id: string;
        owner_type: "interaction" | "fact" | "summary";
        owner_id: string;
        embedding_model: string;
        vector: string;
      }[]
    >`
      select id, owner_type, owner_id, embedding_model, vector::text as vector
      from embeddings
      where namespace_id = ${namespaceId} and status = 'ready'
      order by updated_at desc
      limit ${limit}
    `;
    return rows.map((row) => ({
      embeddingId: row.id,
      ownerType: row.owner_type,
      ownerId: row.owner_id,
      embeddingModel: row.embedding_model,
      vector: parseVectorLiteral(row.vector),
    }));
  }

  async getRecentInteractions(
    namespaceId: string,
    sessionId: string,
    limit: number,
  ): Promise<RecentInteraction[]> {
    const rows = await this.db
      .select({
        id: interactions.id,
        sessionId: interactions.sessionId,
        content: interactions.content,
        tokenCount: interactions.tokenCount,
        createdAt: interactions.createdAt,
      })
      .from(interactions)
      .where(and(eq(interactions.namespaceId, namespaceId), eq(interactions.sessionId, sessionId)))
      .orderBy(desc(interactions.createdAt))
      .limit(limit);
    return rows.map((row) => ({ ...row, createdAt: row.createdAt }));
  }

  async getRecentFacts(namespaceId: string, limit: number): Promise<RecentFact[]> {
    const rows = await this.db
      .select({
        id: facts.id,
        content: facts.content,
        confidence: facts.confidence,
        sourceDeleted: facts.sourceDeleted,
        createdAt: facts.createdAt,
      })
      .from(facts)
      .where(and(eq(facts.namespaceId, namespaceId), eq(facts.sourceDeleted, false)))
      .orderBy(desc(facts.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      confidence: Number(row.confidence ?? 1),
      sourceDeleted: row.sourceDeleted,
      createdAt: row.createdAt,
    }));
  }

  async getLatestSummary(namespaceId: string, sessionId: string): Promise<RecentSummary | null> {
    const rows = await this.db
      .select({
        id: sessionSummaries.id,
        sessionId: sessionSummaries.sessionId,
        content: sessionSummaries.content,
        tokenCount: sessionSummaries.tokenCount,
        createdAt: sessionSummaries.createdAt,
      })
      .from(sessionSummaries)
      .where(
        and(
          eq(sessionSummaries.namespaceId, namespaceId),
          eq(sessionSummaries.sessionId, sessionId),
        ),
      )
      .orderBy(desc(sessionSummaries.version))
      .limit(1);
    return rows[0] ?? null;
  }

  async getInteractionsByIds(namespaceId: string, ids: string[]): Promise<RecentInteraction[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({
        id: interactions.id,
        sessionId: interactions.sessionId,
        content: interactions.content,
        tokenCount: interactions.tokenCount,
        createdAt: interactions.createdAt,
      })
      .from(interactions)
      .where(and(eq(interactions.namespaceId, namespaceId), inArray(interactions.id, ids)));
    return rows;
  }

  async getFactsByIds(namespaceId: string, ids: string[]): Promise<RecentFact[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({
        id: facts.id,
        content: facts.content,
        confidence: facts.confidence,
        sourceDeleted: facts.sourceDeleted,
        createdAt: facts.createdAt,
      })
      .from(facts)
      .where(and(eq(facts.namespaceId, namespaceId), inArray(facts.id, ids)));
    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      confidence: Number(row.confidence ?? 1),
      sourceDeleted: row.sourceDeleted,
      createdAt: row.createdAt,
    }));
  }

  async getSummariesByIds(namespaceId: string, ids: string[]): Promise<RecentSummary[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({
        id: sessionSummaries.id,
        sessionId: sessionSummaries.sessionId,
        content: sessionSummaries.content,
        tokenCount: sessionSummaries.tokenCount,
        createdAt: sessionSummaries.createdAt,
      })
      .from(sessionSummaries)
      .where(and(eq(sessionSummaries.namespaceId, namespaceId), inArray(sessionSummaries.id, ids)));
    return rows;
  }

  async countEmbeddingStatuses(namespaceId: string): Promise<PendingEmbeddingCounts> {
    const rows = await this.client.sql<{ status: string; count: string }[]>`
      select status::text as status, count(*)::text as count
      from embeddings
      where namespace_id = ${namespaceId}
      group by status
    `;
    let pending = 0;
    let failed = 0;
    let ready = 0;
    for (const row of rows) {
      const value = Number(row.count);
      if (row.status === "pending") pending = value;
      else if (row.status === "failed") failed = value;
      else if (row.status === "ready") ready = value;
    }
    return { pending, failed, ready };
  }
}

export function createPostgresRepository(client: DatabaseClient): MemoryRepository {
  return new PostgresMemoryRepository(client);
}

function toAuditRow(entry: AuditEntry) {
  return {
    id: entry.id,
    namespaceId: entry.namespaceId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    createdByAgent: entry.createdByAgent ?? null,
    metadata: entry.metadata ?? {},
  };
}

function zeroVectorLiteral(): string {
  return `[${Array.from({ length: 384 }, () => 0).join(",")}]`;
}

function parseVectorLiteral(literal: string): number[] {
  const trimmed = literal.startsWith("[") ? literal.slice(1, -1) : literal;
  if (!trimmed) return [];
  return trimmed.split(",").map((value) => Number(value));
}

function advisoryLockKeys(namespaceId: string, sessionId: string): [number, number] {
  const digest = createHash("sha256").update(`${namespaceId}\x1f${sessionId}`).digest();
  const k1 = digest.readInt32BE(0);
  const k2 = digest.readInt32BE(4);
  return [k1, k2];
}
