# Release Checklist

Use this checklist for the early v0.1 release.

## Scope Check

- SDK exports `CodeBuddy` and core types
- MCP server is stdio-only and ships tools only
- CLI commands are present: `init`, `serve`, `inspect`, `namespaces`, `prune`, `export`, `stats`, `doctor`
- LangGraph helpers are exported from `codebuddy/langgraph`
- Provider scope is Hugging Face only
- No HTTP transport, hosted service, dashboard, Redis, or separate vector database

## Local Verification

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

## Infrastructure Smoke Test

```bash
docker compose up -d
export DATABASE_URL=postgres://codebuddy:codebuddy@localhost:5432/codebuddy
export HF_TOKEN=hf_your_token
node dist/cli/index.js init
node dist/cli/index.js doctor --skip-model-check
```

Run live model diagnostics only when `HF_TOKEN` is configured and free-tier usage is acceptable:

```bash
node dist/cli/index.js doctor
```

## Package Review

- README reflects the actual public API
- examples use package imports instead of internal paths
- `LICENSE` is MIT
- `CONTRIBUTING.md` documents setup and verification
- package metadata points to `https://github.com/iprashantraj/codebuddy`
- `files` includes release docs and migrations

## Known v0.1 Limits

- conversation and fact content are stored in plaintext
- Hugging Face free-tier models may be cold, gated, unavailable, or rate-limited
- automatic fact extraction and rolling summaries are deferred
- MCP resources, prompts, and HTTP transport are deferred
