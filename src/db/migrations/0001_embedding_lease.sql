ALTER TYPE "embedding_status" ADD VALUE 'processing';--> statement-breakpoint
ALTER TABLE "embeddings" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embeddings_status_created_idx" ON "embeddings" ("status","created_at");
