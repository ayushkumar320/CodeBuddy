# Build Plan

This plan follows the upgraded project definition: single package, Hugging Face only, resilience-first, MCP + CLI + SDK, and Docker at the end.

The improved product behavior is defined jointly by:

- `/.rules`
- `/ARCHITECTURE.md`
- `/README.md`
- `/MODELS.md`
- `/TROUBLESHOOTING.md`
- `/WORKFLOW.md`

These root docs are mandatory inputs to every phase. `/.rules` is the unified build contract. The build should produce the improved version of CodeBuddy by default, not a reduced baseline.

## Phase 1: Foundation

Goal:
Create the single-package TypeScript foundation, source layout, tooling, and basic build surfaces.

Deliverables:

- root `package.json`
- `tsconfig.json`
- `biome.json`
- `src/` layout
- examples folder structure
- initial command and export skeletons

Reference:
See `phase-01-foundation.md`.

Must stay aligned with:

- `/.rules` file layout and locked decisions
- `/README.md` installation, distribution, and public-surface expectations

## Phase 2: Storage And Schema

Goal:
Define the Postgres model, migrations, and bootstrap path for `pgvector`.

Deliverables:

- Drizzle config
- schema definitions
- first migration
- DB bootstrap helpers

Reference:
See `phase-02-storage-and-schema.md`.

Must stay aligned with:

- `/.rules` schema requirements
- `/ARCHITECTURE.md` concurrency, transaction, share, and forget semantics
- `/MODELS.md` embedding dimension validation rules

## Phase 3: HF Resilience Layer

Goal:
Build the Hugging Face foundation before any higher-level feature depends on it.

Deliverables:

- provider adapter contracts
- model registry
- retry and backoff logic
- cold-start handling
- request queueing
- fallback chain
- timeouts
- model-call logging hooks

Reference:
See `phase-03-hf-resilience.md`.

Must stay aligned with:

- `/.rules` HF resilience rules
- `/MODELS.md` model registry, gating rules, and budget assumptions
- `/TROUBLESHOOTING.md` doctor and failure-mode expectations

## Phase 4: Core Memory Pipeline

Goal:
Implement `CodeBuddy` core behavior for remember, recall, and share flows.

Deliverables:

- `CodeBuddy` class
- config validation
- `init()`
- `remember()`
- `share()`
- persistence services

Reference:
See `phase-04-core-memory.md`.

Must stay aligned with:

- `/ARCHITECTURE.md` concurrency, async embedding, and sharing model
- `/README.md` SDK API, sessions, privacy, and conflict behavior
- `/.rules` idempotency, agent identity, and remember batch behavior

## Phase 5: Planner And Tracing

Goal:
Implement context planning and LangSmith tracing across core system flows.

Deliverables:

- planner interface
- default planner
- token-budget packing
- planner stats
- tracing wrappers

Reference:
See `phase-05-planner-and-tracing.md`.

Must stay aligned with:

- `/README.md` recall API behavior including `callerModel` and `conflictMode`
- `/ARCHITECTURE.md` conflicts, caching, and logging expectations
- `/.rules` recall fallback and tracing-related behavior

## Phase 6: MCP, LangGraph, And CLI

Goal:
Expose the package through MCP tools, LangGraph integration, and operational CLI commands.

Deliverables:

- MCP server
- v0.1 MCP tools
- LangGraph node and checkpointer
- CLI commands including `doctor`

Reference:
See `phase-06-mcp-langgraph-cli.md`.

Must stay aligned with:

- `/README.md` MCP tools, LangGraph state schema, and stdio-only transport
- `/.rules` tools-only MCP scope and CLI requirements
- `/TROUBLESHOOTING.md` doctor command expectations

## Phase 7: Examples, Docker, And Release Docs

Goal:
Finish the developer experience, examples, containerized infra, and open-source documentation.

Deliverables:

- example projects
- Docker Compose
- README
- MODELS.md
- TROUBLESHOOTING.md
- CONTRIBUTING and LICENSE

Reference:
See `phase-07-examples-docker-release.md`.

Must stay aligned with:

- `/README.md` product positioning and privacy notes
- `/MODELS.md` tuning and budget guidance
- `/TROUBLESHOOTING.md` operational support guidance
- `/ARCHITECTURE.md` sharing and forget semantics reflected in examples

## Execution rule

Do not move to the next phase until:

- the current phase output exists
- phase-specific acceptance criteria are met
- `current-phase.md` is updated to reflect reality
- the implementation for that phase still conforms to the root product specs
