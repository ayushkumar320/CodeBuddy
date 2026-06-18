import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const VECTOR_DIMENSIONS = 384;
export const HNSW_M = 16;
export const HNSW_EF_CONSTRUCTION = 64;

const vector = customType<{ data: string; driverData: string }>({
  dataType() {
    return `vector(${VECTOR_DIMENSIONS})`;
  },
});

export const memoryTypeEnum = pgEnum("memory_type", ["interaction", "fact", "summary"]);
export const interactionRoleEnum = pgEnum("interaction_role", ["user", "assistant", "system"]);
export const embeddingOwnerTypeEnum = pgEnum("embedding_owner_type", [
  "interaction",
  "fact",
  "summary",
]);
export const embeddingStatusEnum = pgEnum("embedding_status", ["pending", "ready", "failed"]);
export const shareModeEnum = pgEnum("share_mode", ["reference", "snapshot"]);
export const modelCallTypeEnum = pgEnum("model_call_type", ["embedding", "llm"]);
export const modelCallStatusEnum = pgEnum("model_call_status", [
  "success",
  "failed",
  "timeout",
  "rate_limited",
  "gated",
  "fallback",
]);
export const auditActionEnum = pgEnum("audit_action", [
  "remember",
  "remember_batch",
  "share",
  "forget",
  "config",
]);

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const namespaces = pgTable(
  "namespaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdAt,
    updatedAt,
  },
  (table) => ({
    nameUnique: uniqueIndex("namespaces_name_unique").on(table.name),
  }),
);

export const interactions = pgTable(
  "interactions",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    role: interactionRoleEnum("role").notNull().default("user"),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    tokenCount: integer("token_count").notNull().default(0),
    createdByAgent: text("created_by_agent"),
    createdAt,
  },
  (table) => ({
    namespaceContentHashUnique: uniqueIndex("interactions_namespace_content_hash_unique").on(
      table.namespaceId,
      table.contentHash,
    ),
    namespaceSessionCreatedIdx: index("interactions_namespace_session_created_idx").on(
      table.namespaceId,
      table.sessionId,
      table.createdAt,
    ),
  }),
);

export const sessionSummaries = pgTable(
  "session_summaries",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    content: text("content").notNull(),
    version: integer("version").notNull().default(1),
    tokenCount: integer("token_count").notNull().default(0),
    createdByAgent: text("created_by_agent"),
    createdAt,
  },
  (table) => ({
    namespaceSessionVersionIdx: index("session_summaries_namespace_session_version_idx").on(
      table.namespaceId,
      table.sessionId,
      table.version,
    ),
  }),
);

export const facts = pgTable(
  "facts",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    predicate: text("predicate").notNull(),
    object: text("object").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull().default("1"),
    sourceInteractionId: text("source_interaction_id").references(() => interactions.id, {
      onDelete: "set null",
    }),
    sourceDeleted: boolean("source_deleted").notNull().default(false),
    embeddingModel: text("embedding_model"),
    createdByAgent: text("created_by_agent"),
    createdAt,
    updatedAt,
  },
  (table) => ({
    namespaceContentHashUnique: uniqueIndex("facts_namespace_content_hash_unique").on(
      table.namespaceId,
      table.contentHash,
    ),
    namespaceSubjectIdx: index("facts_namespace_subject_idx").on(table.namespaceId, table.subject),
    sourceInteractionIdx: index("facts_source_interaction_idx").on(table.sourceInteractionId),
  }),
);

export const embeddings = pgTable(
  "embeddings",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    ownerType: embeddingOwnerTypeEnum("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    vector: vector("vector").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    status: embeddingStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt,
    updatedAt,
  },
  (table) => ({
    ownerUnique: uniqueIndex("embeddings_owner_unique").on(table.ownerType, table.ownerId),
    namespaceModelStatusIdx: index("embeddings_namespace_model_status_idx").on(
      table.namespaceId,
      table.embeddingModel,
      table.status,
    ),
    vectorHnswIdx: index("embeddings_vector_hnsw_idx").using(
      "hnsw",
      sql`${table.vector} vector_cosine_ops`,
    ),
  }),
);

export const shares = pgTable(
  "shares",
  {
    id: text("id").primaryKey(),
    fromNamespaceId: text("from_namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    toNamespaceId: text("to_namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    sourceFactId: text("source_fact_id")
      .notNull()
      .references(() => facts.id, { onDelete: "cascade" }),
    snapshotFactId: text("snapshot_fact_id").references(() => facts.id, { onDelete: "set null" }),
    mode: shareModeEnum("mode").notNull().default("reference"),
    tombstoned: boolean("tombstoned").notNull().default(false),
    createdByAgent: text("created_by_agent"),
    createdAt,
  },
  (table) => ({
    shareUnique: uniqueIndex("shares_target_source_unique").on(
      table.toNamespaceId,
      table.sourceFactId,
      table.mode,
    ),
    fromNamespaceIdx: index("shares_from_namespace_idx").on(table.fromNamespaceId),
  }),
);

export const checkpoints = pgTable(
  "checkpoints",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    checkpointId: text("checkpoint_id").notNull(),
    parentId: text("parent_id"),
    channelValues: jsonb("channel_values").notNull().default(sql`'{}'::jsonb`),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt,
  },
  (table) => ({
    checkpointUnique: uniqueIndex("checkpoints_thread_checkpoint_unique").on(
      table.namespaceId,
      table.threadId,
      table.checkpointId,
    ),
  }),
);

export const modelCalls = pgTable(
  "model_calls",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").references(() => namespaces.id, { onDelete: "set null" }),
    model: text("model").notNull(),
    type: modelCallTypeEnum("type").notNull(),
    latencyMs: integer("latency_ms"),
    tokens: integer("tokens"),
    status: modelCallStatusEnum("status").notNull(),
    error: text("error"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt,
  },
  (table) => ({
    modelCreatedIdx: index("model_calls_model_created_idx").on(table.model, table.createdAt),
    namespaceCreatedIdx: index("model_calls_namespace_created_idx").on(
      table.namespaceId,
      table.createdAt,
    ),
  }),
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id").references(() => namespaces.id, { onDelete: "set null" }),
    action: auditActionEnum("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    createdByAgent: text("created_by_agent"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt,
  },
  (table) => ({
    namespaceActionCreatedIdx: index("audit_log_namespace_action_created_idx").on(
      table.namespaceId,
      table.action,
      table.createdAt,
    ),
  }),
);
