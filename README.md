# CodeBuddy

MCP memory server for multi-agent systems. CodeBuddy stores agent memory in PostgreSQL with pgvector, uses Hugging Face for embeddings and model calls, exposes an MCP stdio server, and drops into LangGraph flows.

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

Start local Postgres with pgvector:

```bash
docker compose up -d
export DATABASE_URL=postgres://codebuddy:codebuddy@localhost:5432/codebuddy
export HF_TOKEN=hf_your_token
```

Build and initialize:

```bash
npm install
npm run build
node dist/cli/index.js init
node dist/cli/index.js doctor --skip-model-check
```

Run the MCP server:

```bash
node dist/cli/index.js serve
```

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
- v0.1 supports explicit `interaction`, `fact`, and `summary` writes
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

v0.1 ships MCP tools only over stdio. Resources, prompts, and HTTP transport are deferred.

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

## CLI

```bash
codebuddy init
codebuddy serve
codebuddy inspect <namespace>
codebuddy namespaces
codebuddy prune --older-than 30d
codebuddy export <namespace>
codebuddy stats
codebuddy doctor
```

`namespaces` lists namespace summaries. `inspect <namespace>` shows facts and per-agent write breakdowns.

## Examples

- `examples/claude-desktop`: MCP stdio config for Claude Desktop
- `examples/claude-code`: project MCP config for Claude Code
- `examples/langgraph-agent`: LangGraph recall/agent/remember loop
- `examples/multi-agent-handoff`: reference and snapshot sharing across namespaces

## Hugging Face Free-Tier Notes

Hugging Face-hosted models may be cold, gated, rate-limited, or temporarily unavailable. CodeBuddy handles cold starts, retries, queueing, fallback models, and timeout reporting, but free-tier limits still matter.

Use:

```bash
codebuddy doctor
```

Doctor reports database connectivity, pgvector availability, vector/index health, model reachability, gated-model failures, recent calls, estimated daily cap remaining, and config permissions.

## Privacy

- CodeBuddy stores conversation and fact content in plaintext in Postgres
- encryption at rest is the deployment owner’s responsibility
- v0.1 has no automatic PII detection
- sensitivity metadata and redaction workflows are deferred

## License

MIT
