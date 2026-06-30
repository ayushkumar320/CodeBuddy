# CodeBuddy

MCP memory server for multi-agent systems. Curated facts and summaries are
written as readable Markdown under `.codebuddy/memory/` and indexed in
PostgreSQL with pgvector. CodeBuddy also exposes an MCP stdio server and
LangGraph helpers.

## What It Ships

`codebuddy` is a single npm package with four surfaces:

- TypeScript SDK helpers
- MCP server over stdio
- CLI for setup, inspection, export, pruning, stats, and health checks
- LangGraph helpers

## Requirements

- Node 20+
- PostgreSQL 16+
- `pgvector`
- Hugging Face token

Optional peer dependency:

- `@langchain/langgraph`: `^0.2.0 || ^0.3.0`

## Quick Start

Install once globally, then let the interactive wizard wire everything:

```bash
npm install -g @ayushkumar320/codebuddy
codebuddy init
```

`codebuddy init` prompts for your Hugging Face token, validates your Postgres URL, offers to start the bundled `pgvector/pgvector:pg16` container if Postgres isn't reachable, applies migrations, and optionally registers itself with Claude Desktop.

To wire any additional project into Claude Desktop with its own namespace:

```bash
cd ~/Projects/your-project
codebuddy claude install --namespace your-project
```

Then restart Claude Desktop (⌘Q + reopen) and the new namespace's tools are live.

### Team setup

CodeBuddy is designed so multiple developers or agents can share project
knowledge without sharing local secrets.

`codebuddy init` and `codebuddy use` create this project scaffold:

```text
.codebuddy/
├── .gitignore          # keeps local secrets, caches, and locks out of git
├── config.json         # local-only Postgres/token settings
├── memory/
│   ├── facts/          # reviewable Markdown facts
│   └── summaries/      # reviewable Markdown summaries
└── plans/              # reviewable Markdown work plans
```

Commit `.codebuddy/memory/**/*.md` and `.codebuddy/plans/*.md` when you want
the team to share agent memory and plans. Do **not** commit
`.codebuddy/config.json`; each teammate runs `codebuddy use` or `codebuddy init`
locally with their own token and database URL.

Use one namespace per project, for example:

```bash
codebuddy use my-project
```

That keeps each project isolated while still allowing explicit sharing through
the `share` tool when you want one namespace to hand facts to another.

### Manual setup (if you prefer)

```bash
# 1. Start Postgres (pgvector image bundled)
codebuddy postgres up

# 2. Apply migrations
codebuddy migrate

# 3. Run the MCP stdio server
codebuddy serve
```

### Useful commands

```bash
codebuddy doctor              # DB, pgvector, vector index, HF model health
codebuddy claude list         # see all codebuddy entries in Claude Desktop
codebuddy claude remove <key> # detach a namespace from Claude Desktop
codebuddy postgres down       # stop the bundled DB (volume preserved)
codebuddy stats               # storage + usage stats
codebuddy inspect <namespace> # contents + per-agent breakdown
codebuddy list-facts          # paginate facts
codebuddy migrate to-files    # preview export of existing DB memories
codebuddy migrate to-files --write
codebuddy reindex --full      # rebuild facts + summaries from Markdown
codebuddy risk assess --git   # assess risk for current git changes
codebuddy map build           # summarize the lightweight import graph
codebuddy prune --older-than 30d
```

## File-backed memory

Facts and summaries written through normal CLI/MCP runtimes are stored in:

```text
.codebuddy/
└── memory/
    ├── facts/
    │   └── fact_<id>.md
    └── summaries/
        └── sum_<id>.md
```

The Markdown files contain versioned YAML front matter followed by the memory
text. PostgreSQL still stores the current searchable records and embeddings,
but the files can reconstruct facts and summaries after database loss.

Interactions, shares, audit records, model diagnostics, and generated
embeddings remain PostgreSQL-only in this release.

### Upgrade existing memories

Preview the migration without writing files:

```bash
codebuddy migrate to-files
```

Write missing fact and summary files:

```bash
codebuddy migrate to-files --write
```

The operation is non-destructive and idempotent. It does not truncate database
tables or overwrite existing files. If a file has the same ID but different
content, the command reports a conflict with database and file checksums.

Review the output and the generated files before committing them.

### Restore after database loss

Start an empty PostgreSQL database, apply migrations, then rebuild:

```bash
codebuddy postgres up
codebuddy migrate
codebuddy reindex --full
```

Reindex restores fact and summary rows and creates pending embeddings. The
embedding worker regenerates vectors afterward.

### Incident memory

Facts can optionally be tagged as incidents. This lets CodeBuddy remember
past breakages and connect them to files:

```yaml
category: incident
paths:
  - src/auth/oauth.ts
severity: high
introducedBy: abc123
resolvedBy: null
```

Normal facts still work without these fields. Incident facts are useful for
risk checks: if a future plan touches `src/auth/oauth.ts`, CodeBuddy can find
the past incident and warn the agent before it repeats the same mistake.

## Risk and architecture map

CodeBuddy can assess change risk from structured memory, project policy, and
recent Git churn:

```bash
codebuddy risk assess --git
codebuddy risk assess --paths src/auth/oauth.ts,src/api/login.ts
codebuddy risk assess --plan pln_abc123 --explain
codebuddy risk assess --json
```

Optional project policy lives in `.codebuddy/policies.yaml`:

```yaml
rules:
  - id: auth-sensitive
    pattern: "src/auth/**"
    message: "Auth changes need careful review."
    weight: 70
```

The lightweight architecture map scans TypeScript/JavaScript imports on
demand:

```bash
codebuddy map build
codebuddy map deps src/cli/index.ts
codebuddy map dependents src/core/codebuddy.ts
```

### Rollback

The migration does not delete old database records. To roll back before a
database loss, keep using the same database and remove or ignore the generated
`.codebuddy/memory/` directory. Back up the directory before deleting it.

After database loss, Markdown restores facts and summaries only. It cannot
restore raw interactions, share relationships, audit logs, or diagnostics.

## Configuration

Preferred auth source:

- `HF_TOKEN`

Supported config file:

- `.codebuddy/config.json`

Rules:

- `codebuddy init` creates the config file with `0600` permissions
- `codebuddy doctor` warns if permissions are broader than `0600`
- the Hugging Face token must never be logged and is redacted in errors
- v0.1 uses Hugging Face only; additional providers are out of scope

## SDK Example

Use `createRuntime` for production wiring. It creates the Postgres repository, initializes `CodeBuddy`, and returns a `close()` hook that drains the worker and closes the database client.

```ts
import { createRuntime } from "codebuddy";

const runtime = await createRuntime({
  postgresUrl: process.env.DATABASE_URL!,
  provider: {
    type: "huggingface",
    apiKey: process.env.HF_TOKEN,
  },
  namespace: "research-agent",
  tokenBudget: 8000,
});

const remembered = await runtime.memory.remember({
  sessionId: "sess_123",
  content: "Use layer caching for the Docker build.",
  type: "fact",
  idempotencyKey: "msg_123",
  agentId: "agent-a",
});

const context = await runtime.memory.recall({
  sessionId: "sess_123",
  query: "What do we know about deployment?",
  budget: 6000,
  callerModel: "meta-llama/Llama-3.2-3B-Instruct",
  conflictMode: "all",
});

await runtime.memory.share({
  from: "research-agent",
  to: "ops-agent",
  factIds: [remembered.id],
  mode: "reference",
  agentId: "agent-a",
});

await runtime.close();
```

Notes:

- `remember` defaults to `type: "interaction"`
- explicit `interaction`, `fact`, and `summary` writes are supported
- repeated writes with the same idempotency key or same content return `deduplicated: true`
- embeddings are prepared asynchronously; recall falls back to recency while vectors are pending

## MCP Tools

| Tool | Input | Output |
|---|---|---|
| `remember` | `{ sessionId?, content, type?, idempotencyKey?, agentId? }` | `{ id, sessionId, deduplicated }` |
| `remember_batch` | `{ items: [{ sessionId?, content, type?, idempotencyKey?, agentId? }] }` | `{ items: [{ id, sessionId, deduplicated }] }` |
| `recall` | `{ sessionId, query, budget?, callerModel?, conflictMode? }` | `{ system, messages, stats }` |
| `list_facts` | `{ subject?, limit?: number = 50, cursor?: string }` | `{ facts[], nextCursor? }` |
| `list_namespaces` | `{}` | `{ namespaces: [{ name, factCount, lastActivity }] }` |
| `forget` | `{ id }` | `{ ok, entityType }` |
| `share` | `{ to_namespace, factIds, mode?: "reference" \| "snapshot", agentId? }` | `{ shared }` |
| `plan_current` | `{}` | `{ plan, policy }` |
| `plan_create` | `{ title, brief, ... }` | `{ plan }` |
| `plan_amend` | `{ id, patch }` | `{ plan }` |
| `plan_status` | `{ id, status, ... }` | `{ plan }` |
| `risk_assess` | `{ planId?, paths?, useGit?, limit? }` | `{ items, stats }` |
| `map_query` | `{ from?, to?, limit? }` | `ModuleEdge[]` |
| `map_neighbours` | `{ module, direction? }` | `{ modules, edges }` |

MCP currently ships over stdio. HTTP transport remains deferred.

## LangGraph

Expected node state shape:

```ts
type CodeBuddyState = {
  messages: BaseMessage[];
  memory?: PlannedContext;
  sessionId: string;
  agentId?: string;
};
```

Example:

```ts
import { Annotation, StateGraph } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type { PlannedContext } from "codebuddy";
import { CodeBuddyNode, CodeBuddyCheckpointer } from "codebuddy/langgraph";

const State = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  memory: Annotation<PlannedContext | undefined>({
    reducer: (_, right) => right,
    default: () => undefined,
  }),
  sessionId: Annotation<string>({ reducer: (_, right) => right }),
  agentId: Annotation<string | undefined>({
    reducer: (_, right) => right,
    default: () => undefined,
  }),
});

const graph = new StateGraph(State)
  .addNode("recall", new CodeBuddyNode({ memory, mode: "recall", cacheTtlSeconds: 30 }))
  .addNode("agent", agentNode)
  .addNode("remember", new CodeBuddyNode({ memory, mode: "remember" }))
  .compile({ checkpointer: new CodeBuddyCheckpointer({ namespace: "research-agent" }) });
```

Recall caching defaults to 30 seconds and is keyed by `(namespace, sessionId, query)`.

## Examples

- `examples/claude-desktop`: MCP stdio config for Claude Desktop
- `examples/claude-code`: project MCP config for Claude Code
- `examples/langgraph-agent`: LangGraph recall/agent/remember loop
- `examples/multi-agent-handoff`: reference and snapshot sharing across namespaces

For detailed Claude Code and Codex setup with Docker commands, see `CLAUDE_CODEX.md`.

## Hugging Face Free-Tier Notes

Hugging Face-hosted models may be cold, gated, rate-limited, or temporarily unavailable. CodeBuddy handles cold starts, retries, queueing, fallback models, and timeout reporting, but free-tier limits still matter.

Use:

```bash
codebuddy doctor
```

Doctor reports database connectivity, pgvector availability, vector/index health, model reachability, gated-model failures, recent calls, estimated daily cap remaining, and config permissions.

## Privacy

- CodeBuddy stores facts and summaries in plaintext Markdown
- conversations, shares, telemetry, and indexed data are stored in PostgreSQL
- inspect `.codebuddy/memory/` before committing it because facts may contain secrets
- for private project memory, add `.codebuddy/memory/` to the project’s `.gitignore`
- for selective sharing, ignore a private subdirectory and keep public memory separate
- encryption at rest is the deployment owner’s responsibility
- automatic PII detection is not yet shipped
- sensitivity metadata and stronger redaction workflows are planned

## License

MIT
