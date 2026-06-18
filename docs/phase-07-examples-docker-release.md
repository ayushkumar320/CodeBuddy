# Phase 7: Examples, Docker, And Release Docs

## Objective

Finish the project with runnable examples, Docker-based local infrastructure, release docs, and final verification.

## Required references

Read before coding:

- `/.rules`
- `/README.md`
- `/MODELS.md`
- `/TROUBLESHOOTING.md`
- `/WORKFLOW.md`
- `/ARCHITECTURE.md`

## What to build

- Claude Desktop example
- LangGraph agent example
- multi-agent handoff example
- Docker Compose for Postgres + pgvector
- final README polish
- final MODELS and TROUBLESHOOTING polish
- CONTRIBUTING.md
- MIT LICENSE
- release checklist

## Coding prompt

```md
Build Phase 7 for CodeBuddy.

Goal:
Make the completed package easy to run, understand, diagnose, and release.

Hard rules:
- Docker comes after local package behavior is implemented.
- Examples must use real public APIs from the package.
- Docs must not hide Hugging Face free-tier limitations.
- Do not introduce new product scope in the release phase.

Examples:
- Claude Desktop example using MCP stdio.
- LangGraph agent example with `CodeBuddyNode`, `CodeBuddyCheckpointer`, state reducers, and `cacheTtlSeconds: 30`.
- Multi-agent handoff example showing `reference` and `snapshot` sharing, `agentId`, and idempotency.

Docker:
- Add `docker-compose.yml` with `pgvector/pgvector:pg16`.
- Use a named volume.
- Document `DATABASE_URL`.
- Keep app containerization optional unless it materially helps examples.

Docs:
- README leads with MCP memory server for multi-agent systems.
- MODELS explains defaults, dimensions, daily budget, gated models, and vector tuning.
- TROUBLESHOOTING explains doctor output and HF failures.
- WORKFLOW stays understandable for non-experts.
- CONTRIBUTING explains setup, tests, and live HF smoke-test gating.
- LICENSE is MIT with author Prashant Raj and GitHub iprashantraj.

Verification:
- Run typecheck.
- Run unit tests.
- Run integration tests if Docker is available.
- Run package build.
- Note any tests skipped due to missing Docker or live HF credentials.

Definition of done:
- A new contributor can understand the product, run local infra, run examples, and diagnose common failures.
- The package is ready for an early public v0.1 release.
```

## Exit criteria

- examples exist and match public APIs
- Docker Compose exists
- release docs exist
- build/test status is documented
- project is ready for early release

