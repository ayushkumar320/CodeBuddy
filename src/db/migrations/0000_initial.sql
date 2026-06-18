CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE memory_type AS ENUM ('interaction', 'fact', 'summary');
CREATE TYPE interaction_role AS ENUM ('user', 'assistant', 'system');
CREATE TYPE embedding_owner_type AS ENUM ('interaction', 'fact', 'summary');
CREATE TYPE embedding_status AS ENUM ('pending', 'ready', 'failed');
CREATE TYPE share_mode AS ENUM ('reference', 'snapshot');
CREATE TYPE model_call_type AS ENUM ('embedding', 'llm');
CREATE TYPE model_call_status AS ENUM (
  'success',
  'failed',
  'timeout',
  'rate_limited',
  'gated',
  'fallback'
);
CREATE TYPE audit_action AS ENUM (
  'remember',
  'remember_batch',
  'share',
  'forget',
  'config'
);

CREATE TABLE namespaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX namespaces_name_unique ON namespaces (name);

CREATE TABLE interactions (
  id text PRIMARY KEY,
  namespace_id text NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  role interaction_role NOT NULL DEFAULT 'user',
  content text NOT NULL,
  content_hash text NOT NULL,
  token_count integer NOT NULL DEFAULT 0,
  created_by_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX interactions_namespace_content_hash_unique
  ON interactions (namespace_id, content_hash);
CREATE INDEX interactions_namespace_session_created_idx
  ON interactions (namespace_id, session_id, created_at);

CREATE TABLE session_summaries (
  id text PRIMARY KEY,
  namespace_id text NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  content text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  token_count integer NOT NULL DEFAULT 0,
  created_by_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX session_summaries_namespace_session_version_idx
  ON session_summaries (namespace_id, session_id, version);

CREATE TABLE facts (
  id text PRIMARY KEY,
  namespace_id text NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  subject text NOT NULL,
  predicate text NOT NULL,
  object text NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL,
  confidence numeric(5, 4) NOT NULL DEFAULT 1,
  source_interaction_id text REFERENCES interactions(id) ON DELETE SET NULL,
  source_deleted boolean NOT NULL DEFAULT false,
  embedding_model text,
  created_by_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX facts_namespace_content_hash_unique
  ON facts (namespace_id, content_hash);
CREATE INDEX facts_namespace_subject_idx ON facts (namespace_id, subject);
CREATE INDEX facts_source_interaction_idx ON facts (source_interaction_id);

CREATE TABLE embeddings (
  id text PRIMARY KEY,
  namespace_id text NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  owner_type embedding_owner_type NOT NULL,
  owner_id text NOT NULL,
  vector vector(384) NOT NULL,
  embedding_model text NOT NULL,
  status embedding_status NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX embeddings_owner_unique ON embeddings (owner_type, owner_id);
CREATE INDEX embeddings_namespace_model_status_idx
  ON embeddings (namespace_id, embedding_model, status);
CREATE INDEX embeddings_vector_hnsw_idx
  ON embeddings USING hnsw (vector vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TABLE shares (
  id text PRIMARY KEY,
  from_namespace_id text NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  to_namespace_id text NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  source_fact_id text NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  snapshot_fact_id text REFERENCES facts(id) ON DELETE SET NULL,
  mode share_mode NOT NULL DEFAULT 'reference',
  tombstoned boolean NOT NULL DEFAULT false,
  created_by_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX shares_target_source_unique
  ON shares (to_namespace_id, source_fact_id, mode);
CREATE INDEX shares_from_namespace_idx ON shares (from_namespace_id);

CREATE TABLE checkpoints (
  id text PRIMARY KEY,
  namespace_id text NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  checkpoint_id text NOT NULL,
  parent_id text,
  channel_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX checkpoints_thread_checkpoint_unique
  ON checkpoints (namespace_id, thread_id, checkpoint_id);

CREATE TABLE model_calls (
  id text PRIMARY KEY,
  namespace_id text REFERENCES namespaces(id) ON DELETE SET NULL,
  model text NOT NULL,
  type model_call_type NOT NULL,
  latency_ms integer,
  tokens integer,
  status model_call_status NOT NULL,
  error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX model_calls_model_created_idx ON model_calls (model, created_at);
CREATE INDEX model_calls_namespace_created_idx ON model_calls (namespace_id, created_at);

CREATE TABLE audit_log (
  id text PRIMARY KEY,
  namespace_id text REFERENCES namespaces(id) ON DELETE SET NULL,
  action audit_action NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  created_by_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_namespace_action_created_idx
  ON audit_log (namespace_id, action, created_at);
