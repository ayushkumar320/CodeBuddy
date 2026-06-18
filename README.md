# CodeBuddy

MCP memory server for multi-agent systems. Free to run end to end on Hugging Face + Postgres. Drops into LangGraph in one line.

## What It Ships

`codebuddy` is a single npm package with four surfaces:

- a TypeScript SDK
- an MCP server over stdio
- a CLI for setup, inspection, recall diagnostics, and health checks
- LangGraph helpers

## Installation

Requirements:

- Node 20+
- PostgreSQL 16+
- `pgvector`

Optional peer dependency:

- `@langchain/langgraph`: `^0.2.0 || ^0.3.0`

CI should test both supported LangGraph ranges.

## Configuration

Preferred auth source:

- `HF_TOKEN` environment variable

Supported config file:

- `.codebuddy/config.json`

Rules:

- `codebuddy init` must create the config file with `0600` permissions
- `codebuddy doctor` must warn if permissions are broader than `0600`
- the token must never be logged and must always be redacted in errors

## Core Concepts

### Namespaces

Namespaces isolate memory across agents or teams. The same `sessionId` in two namespaces is unrelated.

### Sessions

- `sessionId` is opaque and client-provided
- if omitted on `remember`, CodeBuddy generates `sess_<ulid>` and returns it
- sessions are scoped to a namespace
- sessions do not have an explicit end; they are grouping keys for ordering and summaries

### Sharing

Shares are references by default, with optional snapshots.

- `reference`: target namespace reads the live fact and sees future source updates
- `snapshot`: target namespace gets a copy and future source updates do not propagate

### Conflicts

By default, `recall` returns all matching facts sorted by `confidence x recency`. CodeBuddy does not auto-resolve contradictory facts in v0.1. The consuming LLM is responsible for reconciliation unless the caller narrows behavior with `conflictMode`.

## SDK API

```ts
import { CodeBuddy } from "codebuddy";

const memory = new CodeBuddy({
  postgresUrl: process.env.DATABASE_URL!,
  provider: {
    type: "huggingface",
    apiKey: process.env.HF_TOKEN!,
  },
  namespace: "research-agent",
  tokenBudget: 8000,
});

await memory.init();

const remembered = await memory.remember({
  sessionId: "sess_123",
  content: "Use layer caching for the Docker build.",
  type: "fact",
  idempotencyKey: "msg_123",
  agentId: "agent-a",
});

const batch = await memory.rememberBatch([
  { sessionId: "sess_123", content: "Agent A likes concise reports.", type: "fact" },
  { sessionId: "sess_123", content: "The deployment target is eu-west-1.", type: "fact" },
]);

const context = await memory.recall({
  sessionId: "sess_123",
  query: "What do we know about deployment?",
  budget: 6000,
  callerModel: "meta-llama/Llama-3.2-3B-Instruct",
  conflictMode: "all",
});

await memory.share({
  from: "research-agent",
  to: "ops-agent",
  factIds: ["fact_123"],
  mode: "reference",
  agentId: "agent-a",
});
```

Notes:

- `recall({ sessionId, query, budget?, callerModel?, conflictMode? })`
- when `callerModel` is provided, CodeBuddy validates the requested budget against a built-in context-window registry, logs a warning, and clamps if needed
- every write accepts `agentId?: string`
- `remember` defaults to `type: "interaction"` when no type is provided
- v0.1 supports explicit `interaction`, `fact`, and `summary` writes; automatic fact extraction and rolling summaries can be added later behind the same provider layer

## MCP Tools

| Tool | Input | Output |
|---|---|---|
| `remember` | `{ sessionId?, content, type?, idempotencyKey?, agentId? }` | `{ id, sessionId, deduplicated: boolean }` |
| `remember_batch` | `{ items: [{ sessionId?, content, type?, idempotencyKey?, agentId? }] }` | `{ items: [{ id, sessionId, deduplicated: boolean }] }` |
| `recall` | `{ sessionId, query, budget?, callerModel?, conflictMode? }` | `{ system, messages, stats }` |
| `list_facts` | `{ subject?, limit?: number = 50, cursor?: string }` | `{ facts[], nextCursor?: string }` |
| `list_namespaces` | `{}` | `{ namespaces: [{ name, factCount, lastActivity }] }` |
| `forget` | `{ id }` | `{ ok }` |
| `share` | `{ to_namespace, factIds, mode?: "reference" \| "snapshot", agentId? }` | `{ shared }` |

Retried calls with the same idempotency key, or identical content when the key is omitted, return the original id and `deduplicated: true`.

## LangGraph

Supported peer dependency:

- `@langchain/langgraph`: `^0.2.0 || ^0.3.0`

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
  sessionId: Annotation<string>({
    reducer: (_, right) => right,
  }),
  agentId: Annotation<string | undefined>({
    reducer: (_, right) => right,
    default: () => undefined,
  }),
});

const graph = new StateGraph(State)
  .addNode("recall", new CodeBuddyNode({ memory, mode: "recall", cacheTtlSeconds: 30 }))
  .addNode("agent", agentNode)
  .addNode("remember", new CodeBuddyNode({ memory, mode: "remember" }))
  .compile({ checkpointer: new CodeBuddyCheckpointer({ memory }) });
```

`CodeBuddyNode` defaults to a 30-second recall cache keyed by `(namespace, sessionId, query)`, which helps avoid repeated retrieval inside graph cycles.

## Distribution

v0.1 ships stdio transport only for MCP. HTTP transport with bearer-token auth is deferred to v0.2.

## Privacy And Data Handling

- CodeBuddy stores conversation content in plaintext in Postgres
- encryption at rest is the user's responsibility at the Postgres layer
- v0.1 has no automatic PII detection
- v0.2 is expected to add fact sensitivity metadata and a `--redact` flow

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

`codebuddy namespaces` is an alias for `inspect` without arguments. `codebuddy inspect` should show per-agent breakdowns for writes.
