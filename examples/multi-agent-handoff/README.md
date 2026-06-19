# Multi-Agent Handoff Example

This example shows two namespaces sharing memory.

Flow:

1. `research-agent` writes a fact with `agentId` and `idempotencyKey`.
2. `research-agent` shares that fact to `ops-agent` in `reference` mode.
3. `ops-agent` recalls deployment context from its own namespace.
4. `research-agent` also creates a `snapshot` share to show the second share mode.

## Run

```bash
docker compose up -d
export DATABASE_URL=postgres://codebuddy:codebuddy@localhost:5432/codebuddy
export HF_TOKEN=hf_your_token
npm run build
npx tsx examples/multi-agent-handoff/index.ts
```

## Behaviors To Notice

- namespaces isolate memory until a share is created
- `reference` shares point to the live source fact
- `snapshot` shares copy the fact for the target namespace
- repeating the example returns `deduplicated: true` for the same `idempotencyKey`
- `agentId` gives inspect and audit views a stable writer attribution

Inspect after running:

```bash
node dist/cli/index.js inspect research-agent
node dist/cli/index.js inspect ops-agent
```
