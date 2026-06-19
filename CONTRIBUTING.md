# Contributing

Thanks for helping improve CodeBuddy.

## Setup

Requirements:

- Node 20+
- npm
- Docker, if you want local Postgres + pgvector
- a Hugging Face token for live provider smoke tests

Install dependencies:

```bash
npm install
```

Start local infrastructure:

```bash
docker compose up -d
export DATABASE_URL=postgres://codebuddy:codebuddy@localhost:5432/codebuddy
export HF_TOKEN=hf_your_token
```

Initialize local config:

```bash
npm run build
node dist/cli/index.js init
```

## Verification

Run these before opening a pull request:

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

Use `codebuddy doctor` when local behavior feels broken:

```bash
node dist/cli/index.js doctor
```

## Live Hugging Face Checks

Unit tests should not require live Hugging Face credentials. Any live provider smoke test must be opt-in and skipped unless `HF_TOKEN` is set.

When adding live checks:

- keep them small
- document expected free-tier limitations
- never log `HF_TOKEN`
- treat gated models as a setup problem, not a retryable failure

## Scope

v0.1 is intentionally narrow:

- single npm package
- PostgreSQL 16 + pgvector
- Hugging Face provider only
- MCP over stdio only
- no hosted service, dashboard, REST API, Redis, or separate vector database
