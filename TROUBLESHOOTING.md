# Troubleshooting

## Doctor First

Start with:

```bash
codebuddy doctor
```

It should report:

- model reachability
- cold or warm status
- last error per model
- calls in last 60s, last hour, and last 24h
- estimated daily cap remaining
- warnings when usage exceeds 80% of daily cap
- Postgres connectivity
- `pgvector` availability
- vector index health
- config file permission warnings

## Common Hugging Face Failures

### Model Is Cold

Symptom:

- 503 with `estimated_time`

Expected behavior:

- wait for `estimated_time` plus jitter
- retry later instead of hammering the endpoint

### Rate Limited

Symptom:

- 429 or `Retry-After`

Expected behavior:

- obey queue limits
- back off before retrying

### Model Is Gated

Symptom:

- 403

Behavior:

- do not retry
- do not auto-fallback

Expected error:

`Model <name> is gated. Accept the license at https://huggingface.co/<name> and retry.`

This should be treated as a blocking diagnostic by `codebuddy doctor`.

### Model Unavailable

Symptom:

- 404 or repeated unavailable responses

Expected behavior:

- fail the current model cleanly
- use configured fallback chain when allowed

### Requests Hang

Symptom:

- long waits with no completion

Expected behavior:

- time out per call
- surface the timeout and last known model state

## Config And API Key Issues

- prefer `HF_TOKEN` over file-based secrets
- if `.codebuddy/config.json` stores the token, it must be `0600`
- doctor should warn when permissions are too open
- logs and errors must redact tokens

## Doctor Output Interpretation

High calls in last 24h plus low estimated cap remaining means the current defaults may be too aggressive for the free tier.

High vector counts per namespace may justify index tuning or later reindex work.

Repeated gated-model failures usually mean the Hugging Face license acceptance step was missed.

## Docker Local Database

Start the local database with:

```bash
docker compose up -d
export DATABASE_URL=postgres://codebuddy:codebuddy@localhost:5432/codebuddy
```

If `codebuddy doctor` reports that `pgvector` is unavailable, confirm the running image is `pgvector/pgvector:pg16` and recreate the container if it was previously started from a plain Postgres image.

## Stdio MCP Issues

v0.1 supports MCP over stdio only. Logs are written to stderr so stdout remains reserved for MCP protocol messages.

If a desktop MCP client fails to start CodeBuddy:

- run `codebuddy serve` from a shell with the same `DATABASE_URL` and `HF_TOKEN`
- run `codebuddy doctor --skip-model-check` to separate database issues from Hugging Face issues
- use an absolute path to `dist/cli/index.js` for local development configs
