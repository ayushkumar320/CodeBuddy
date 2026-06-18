# Current Phase

## Status

Current phase: `Phase 1 - Foundation`

Project state:

- documentation has been updated to the upgraded single-package plan
- root product docs now define the improved target behavior
- `/.rules` now consolidates the complete build context
- `/WORKFLOW.md` explains the app flow in plain language and detail
- implementation has not started yet
- the repo currently contains docs only

## What to build next

Build the single-package foundation first.

Next concrete tasks:

1. Create root `package.json`, `tsconfig.json`, and `biome.json`.
2. Create `src/` with domains for core, planner, providers, db, mcp, langgraph, tracing, and cli.
3. Add CLI and SDK entry skeletons.
4. Add placeholder example directories.
5. Keep everything minimal but structurally valid.
6. Make sure the structure matches `/.rules` and `/README.md`.

## What not to build yet

- Docker
- Drizzle schema
- Hugging Face runtime integration
- resilience layer
- planner logic
- MCP tools
- LangGraph integration
- any scaffold drift from the improved root product docs

## Ready-to-use execution prompt

```md
We are in Phase 1 for CodeBuddy.

Build the single-package foundation only.

Rules:
- Use a single npm package named `codebuddy`.
- Use ESM-only strict TypeScript.
- Add `src/` placeholders for core, planner, providers, db, mcp, langgraph, tracing, and cli.
- Add CLI and SDK entry skeletons.
- Add placeholder example directories.
- Match the structure and public surfaces already locked in `/.rules`, `/README.md`, and `/ARCHITECTURE.md`.
- Do not add Docker.
- Do not add database schema yet.
- Do not add Hugging Face runtime logic yet.

Expected outcome:
- the project has a clean single-package structure
- configs are in place
- entry points are clear
- the repo is ready for schema work next
- the foundation already points toward the improved product shape rather than a stripped-down scaffold
```

## When to update this file

Update this file immediately after Phase 1 is complete. The next version should point to `Phase 2 - Storage And Schema` and list the exact schema tasks to begin.
