# Phase 1: Foundation

## Objective

Create the single-package TypeScript foundation for `codebuddy` without adding database logic, provider calls, or Docker.

## Required references

Read before coding:

- `/.rules`
- `/README.md`
- `/ARCHITECTURE.md`
- `/WORKFLOW.md`

## What to build

- root `package.json`
- `tsconfig.json`
- `biome.json`
- `tsup.config.ts`
- `vitest.config.ts`
- `src/` source layout
- `examples/` placeholders
- SDK export skeleton
- CLI bin skeleton
- package export map skeleton

## Coding prompt

```md
Build Phase 1 for CodeBuddy.

Goal:
Create only the single-package foundation for the improved CodeBuddy product described in `/.rules`.

Hard rules:
- Use one npm package named `codebuddy`.
- Use ESM only.
- Use strict TypeScript.
- Do not create a monorepo.
- Do not add database schema yet.
- Do not add Hugging Face runtime logic yet.
- Do not add Docker yet.
- Do not implement real MCP tools yet.

Create:
- `package.json` with scripts for `build`, `dev`, `typecheck`, `test`, `lint`, and `format`.
- package exports for `.`, `./langgraph`, and the CLI bin.
- dependencies and peer dependencies listed in `/.rules`.
- `tsconfig.json` with strict settings.
- `biome.json`.
- `tsup.config.ts` for ESM output, declarations, and bin support.
- `vitest.config.ts`.
- source folders matching `/.rules`.
- placeholder `src/index.ts`.
- placeholder `src/cli/index.ts` with a non-functional command shell.
- placeholder `src/langgraph/index.ts` or equivalent export surface.
- example folders for Claude Desktop, LangGraph agent, and multi-agent handoff.

Validation:
- Run typecheck if dependencies are available.
- If dependencies are not installed, verify JSON/config syntax by inspection and mention that tests were not run.

Definition of done:
- The repo is structurally ready for Phase 2.
- The scaffold already points to the full improved product: SDK, CLI, MCP stdio server, LangGraph helpers.
- No runtime behavior is prematurely implemented.
```

## Exit criteria

- package layout matches `/.rules`
- root tooling files exist
- source domains are scaffolded
- CLI and SDK entry points are present
- next phase can add schema without restructuring
