# Current Phase

## Status

Current phase: `Release Ready`

Project state:

- Phases 1-7 are complete
- SDK, MCP stdio, CLI, and LangGraph surfaces exist
- MCP v0.1 ships tools only
- Provider scope is Hugging Face only
- Local Postgres + pgvector infrastructure is documented through Docker Compose
- Examples exist for Claude Desktop, LangGraph, and multi-agent handoff
- Release docs exist: `CONTRIBUTING.md`, `LICENSE`, `RELEASE.md`
- Package metadata and README reflect v0.1 scope

## Verification

Run before release:

```bash
npm run typecheck
npm test
npm run lint
npm run build
docker compose config
```

Optional live checks:

```bash
docker compose up -d
export DATABASE_URL=postgres://codebuddy:codebuddy@localhost:5432/codebuddy
export HF_TOKEN=hf_your_token
node dist/cli/index.js doctor
```

Live Hugging Face checks require credentials and may be affected by free-tier cold starts, gating, or rate limits.

## Deferred Scope

- HTTP MCP transport
- MCP resources and prompts
- hosted service behavior
- dashboard UI
- providers beyond Hugging Face
- automatic fact extraction and rolling summaries
