CREATE TYPE "public"."audit_action" AS ENUM('remember', 'remember_batch', 'share', 'forget', 'config');--> statement-breakpoint
CREATE TYPE "public"."embedding_owner_type" AS ENUM('interaction', 'fact', 'summary');--> statement-breakpoint
CREATE TYPE "public"."embedding_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."interaction_role" AS ENUM('user', 'assistant', 'system');--> statement-breakpoint
CREATE TYPE "public"."memory_type" AS ENUM('interaction', 'fact', 'summary');--> statement-breakpoint
CREATE TYPE "public"."model_call_status" AS ENUM('success', 'failed', 'timeout', 'rate_limited', 'gated', 'fallback');--> statement-breakpoint
CREATE TYPE "public"."model_call_type" AS ENUM('embedding', 'llm');--> statement-breakpoint
CREATE TYPE "public"."share_mode" AS ENUM('reference', 'snapshot');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"namespace_id" text,
	"action" "audit_action" NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"created_by_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"namespace_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"checkpoint_id" text NOT NULL,
	"parent_id" text,
	"channel_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" text PRIMARY KEY NOT NULL,
	"namespace_id" text NOT NULL,
	"owner_type" "embedding_owner_type" NOT NULL,
	"owner_id" text NOT NULL,
	"vector" vector(384) NOT NULL,
	"embedding_model" text NOT NULL,
	"status" "embedding_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" text PRIMARY KEY NOT NULL,
	"namespace_id" text NOT NULL,
	"subject" text NOT NULL,
	"predicate" text NOT NULL,
	"object" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"confidence" numeric(5, 4) DEFAULT '1' NOT NULL,
	"source_interaction_id" text,
	"source_deleted" boolean DEFAULT false NOT NULL,
	"embedding_model" text,
	"created_by_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"namespace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"role" "interaction_role" DEFAULT 'user' NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"created_by_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"namespace_id" text,
	"model" text NOT NULL,
	"type" "model_call_type" NOT NULL,
	"latency_ms" integer,
	"tokens" integer,
	"status" "model_call_status" NOT NULL,
	"error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "namespaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_summaries" (
	"id" text PRIMARY KEY NOT NULL,
	"namespace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"content" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"created_by_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" text PRIMARY KEY NOT NULL,
	"from_namespace_id" text NOT NULL,
	"to_namespace_id" text NOT NULL,
	"source_fact_id" text NOT NULL,
	"snapshot_fact_id" text,
	"mode" "share_mode" DEFAULT 'reference' NOT NULL,
	"tombstoned" boolean DEFAULT false NOT NULL,
	"created_by_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_source_interaction_id_interactions_id_fk" FOREIGN KEY ("source_interaction_id") REFERENCES "public"."interactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_summaries" ADD CONSTRAINT "session_summaries_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_from_namespace_id_namespaces_id_fk" FOREIGN KEY ("from_namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_to_namespace_id_namespaces_id_fk" FOREIGN KEY ("to_namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_source_fact_id_facts_id_fk" FOREIGN KEY ("source_fact_id") REFERENCES "public"."facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_snapshot_fact_id_facts_id_fk" FOREIGN KEY ("snapshot_fact_id") REFERENCES "public"."facts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_namespace_action_created_idx" ON "audit_log" USING btree ("namespace_id","action","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "checkpoints_thread_checkpoint_unique" ON "checkpoints" USING btree ("namespace_id","thread_id","checkpoint_id");--> statement-breakpoint
CREATE UNIQUE INDEX "embeddings_owner_unique" ON "embeddings" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "embeddings_namespace_model_status_idx" ON "embeddings" USING btree ("namespace_id","embedding_model","status");--> statement-breakpoint
CREATE INDEX "embeddings_vector_hnsw_idx" ON "embeddings" USING hnsw ("vector" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "facts_namespace_content_hash_unique" ON "facts" USING btree ("namespace_id","content_hash");--> statement-breakpoint
CREATE INDEX "facts_namespace_subject_idx" ON "facts" USING btree ("namespace_id","subject");--> statement-breakpoint
CREATE INDEX "facts_source_interaction_idx" ON "facts" USING btree ("source_interaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "interactions_namespace_content_hash_unique" ON "interactions" USING btree ("namespace_id","content_hash");--> statement-breakpoint
CREATE INDEX "interactions_namespace_session_created_idx" ON "interactions" USING btree ("namespace_id","session_id","created_at");--> statement-breakpoint
CREATE INDEX "model_calls_model_created_idx" ON "model_calls" USING btree ("model","created_at");--> statement-breakpoint
CREATE INDEX "model_calls_namespace_created_idx" ON "model_calls" USING btree ("namespace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "namespaces_name_unique" ON "namespaces" USING btree ("name");--> statement-breakpoint
CREATE INDEX "session_summaries_namespace_session_version_idx" ON "session_summaries" USING btree ("namespace_id","session_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "shares_target_source_unique" ON "shares" USING btree ("to_namespace_id","source_fact_id","mode");--> statement-breakpoint
CREATE INDEX "shares_from_namespace_idx" ON "shares" USING btree ("from_namespace_id");