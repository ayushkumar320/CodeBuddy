# CodeBuddy Build Docs

This folder is the operating manual for building `CodeBuddy` in a disciplined, phase-based way.

The goal is to keep the project:

- open-source friendly
- strict in scope and architecture
- buildable on Hugging Face free-tier constraints
- easy to resume after breaks
- clear about what to build next

## Files

- `build-plan.md`: phase-by-phase roadmap
- `phase-01-foundation.md`: implementation brief for foundation work
- `phase-02-storage-and-schema.md`: implementation brief for Postgres and schema work
- `phase-03-hf-resilience.md`: implementation brief for the Hugging Face resilience foundation
- `phase-04-core-memory.md`: implementation brief for the core memory pipeline
- `phase-05-planner-and-tracing.md`: implementation brief for planning and tracing
- `phase-06-mcp-langgraph-cli.md`: implementation brief for MCP, LangGraph, and CLI work
- `phase-07-examples-docker-release.md`: final examples, Docker, and release brief
- `current-phase.md`: the single source of truth for what to build next

Root product specs that every build phase must follow:

- `/.rules`: unified build contract and highest-priority implementation context
- `/README.md`: product positioning, public API, MCP surface, LangGraph usage, privacy, and CLI shape
- `/ARCHITECTURE.md`: concurrency, transactions, async embeddings, sharing, conflicts, caching, logging, and forget semantics
- `/MODELS.md`: model registry, dimension rules, gated-model handling, daily budget assumptions, and vector tuning notes
- `/TROUBLESHOOTING.md`: expected doctor outputs, config safety, and Hugging Face failure handling
- `/WORKFLOW.md`: layman and detailed explanation of how the app works

## How to use these docs

1. Read `/.rules` first.
2. Read the root product specs at `/README.md`, `/ARCHITECTURE.md`, `/MODELS.md`, `/TROUBLESHOOTING.md`, and `/WORKFLOW.md`.
3. Work from `current-phase.md`.
4. Open the matching phase file and execute that prompt fully before moving on.
5. Treat the root product specs as binding requirements for every phase, not optional references.
6. Only dockerize after the package works locally end to end.

## Build Contract

The planning docs and the root product docs are linked intentionally.

Rules:

- the phase docs define build order and execution boundaries
- `/.rules` defines the unified build contract
- the root product docs define the improved target behavior and product semantics
- if a phase doc is shorter than the root product spec, the root product spec still wins
- implementation should always converge to the improved project described in `/.rules`, `/ARCHITECTURE.md`, `/README.md`, `/MODELS.md`, `/TROUBLESHOOTING.md`, and `/WORKFLOW.md`
- if a phase doc conflicts with a root product doc, update the phase doc first before building
