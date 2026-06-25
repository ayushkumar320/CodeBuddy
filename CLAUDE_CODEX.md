# Claude Code And Codex Setup

This guide shows how to use CodeBuddy with Claude Code and Codex using a local Docker PostgreSQL database.

## Requirements

- Node.js 20+
- Docker Desktop or Docker Engine
- npm
- Hugging Face token

Create a Hugging Face token at:

```text
https://huggingface.co/settings/tokens
```

## Install CodeBuddy

Install the package globally:

```bash
npm install -g @ayushkumar320/codebuddy
```

Check the CLI:

```bash
codebuddy --help
```

## Start PostgreSQL With Docker

CodeBuddy ships with a Docker Compose file that runs PostgreSQL 16 with `pgvector`.

Start the bundled database:

```bash
codebuddy postgres up
```

Check status:

```bash
codebuddy postgres status
```

The default database URL is:

```text
postgres://codebuddy:codebuddy@localhost:5432/codebuddy
```

You can also use raw Docker Compose from a local clone of this repository:

```bash
docker compose up -d
docker compose ps
```

View logs:

```bash
docker compose logs postgres
docker compose logs -f postgres
```

Open a PostgreSQL shell:

```bash
docker exec -it codebuddy-postgres psql -U codebuddy -d codebuddy
```

Inside `psql`, verify `pgvector`:

```sql
SELECT extname FROM pg_extension WHERE extname = 'vector';
```

Exit:

```sql
\q
```

Stop the database while preserving data:

```bash
codebuddy postgres down
```

or:

```bash
docker compose down
```

Reset the local database by deleting the Docker volume:

```bash
docker compose down
docker volume ls | grep codebuddy
docker volume rm <codebuddy-volume-name>
docker compose up -d
```

Before resetting the volume, export any older database-only facts and
summaries:

```bash
codebuddy migrate to-files
codebuddy migrate to-files --write
```

After resetting the volume:

```bash
codebuddy migrate
codebuddy reindex --full
```

Facts and summaries can be restored from `.codebuddy/memory/`. Raw
interactions, shares, audit logs, and model diagnostics remain database-only
and are lost with the volume.

## Memory Privacy

Markdown memory is plaintext. Inspect it before committing:

```bash
find .codebuddy/memory -type f -maxdepth 3
```

To keep all project memory private, add this to the project `.gitignore`:

```gitignore
.codebuddy/memory/
```

Do not place API tokens, passwords, private keys, or unredacted personal data
in committed memory files.

## Initialize CodeBuddy

Run the setup wizard:

```bash
codebuddy init
```

The wizard asks for:

- Hugging Face token
- PostgreSQL URL
- default namespace
- whether to register with Claude Desktop

For local Docker PostgreSQL, use:

```text
postgres://codebuddy:codebuddy@localhost:5432/codebuddy
```

Run migrations manually if needed:

```bash
codebuddy migrate
```

Check health:

```bash
codebuddy doctor
```

Skip live model checks:

```bash
codebuddy doctor --skip-model-check
```

## One-Command Project Setup

For each project, run:

```bash
cd /path/to/your-project
codebuddy use
```

This command:

- derives the namespace from the project folder
- reuses saved Hugging Face and database settings
- starts Docker PostgreSQL when using the default local database URL
- applies migrations
- registers Claude Desktop
- registers Codex

Use a custom namespace:

```bash
codebuddy use my-project
```

Use a custom PostgreSQL URL:

```bash
codebuddy use --postgres-url "postgres://user:password@host:5432/database"
```

Skip Claude Desktop registration:

```bash
codebuddy use --skip-claude
```

Skip Codex registration:

```bash
codebuddy use --skip-codex
```

## Claude Code Setup

Claude Code reads MCP servers from a project `.mcp.json` file.

In your project:

```bash
cd /path/to/your-project
```

Create `.mcp.json`:

```json
{
  "mcpServers": {
    "codebuddy": {
      "command": "codebuddy",
      "args": ["serve"],
      "env": {
        "DATABASE_URL": "postgres://codebuddy:codebuddy@localhost:5432/codebuddy",
        "HF_TOKEN": "hf_your_token",
        "CODEBUDDY_NAMESPACE": "your-project"
      }
    }
  }
}
```

Replace:

- `hf_your_token` with your Hugging Face token
- `your-project` with your namespace

Restart Claude Code after creating or editing `.mcp.json`.

Test from Claude Code by asking:

```text
Remember that this project uses CodeBuddy for MCP memory.
```

Then ask:

```text
Recall what you know about this project.
```

## Codex Setup

The easiest Codex setup is:

```bash
cd /path/to/your-project
codebuddy use
```

Then restart Codex.

Check Codex entries:

```bash
codebuddy codex list
```

Install a Codex entry manually:

```bash
codebuddy codex install --namespace your-project
```

Remove a Codex entry:

```bash
codebuddy codex remove codebuddy-your-project
```

CodeBuddy writes Codex MCP configuration to:

```text
~/.codex/config.toml
```

The generated entry looks like:

```toml
[mcp_servers."codebuddy-your-project"]
command = "codebuddy"
args = ["serve"]

[mcp_servers."codebuddy-your-project".env]
CODEBUDDY_NAMESPACE = "your-project"
DATABASE_URL = "postgres://codebuddy:codebuddy@localhost:5432/codebuddy"
HF_TOKEN = "hf_your_token"
```

Restart Codex after installing or changing an MCP entry.

## Useful CLI Commands

List namespaces:

```bash
codebuddy namespaces
```

Inspect a namespace:

```bash
codebuddy inspect your-project
```

List facts:

```bash
codebuddy list-facts
```

Export a namespace:

```bash
codebuddy export your-project > codebuddy-memory.json
```

Show storage and usage stats:

```bash
codebuddy stats
```

Delete old memories:

```bash
codebuddy prune --older-than 30d
```

## Troubleshooting

If PostgreSQL is not reachable:

```bash
codebuddy postgres up
codebuddy doctor --skip-model-check
```

If Docker is not running, start Docker first, then run:

```bash
codebuddy postgres up
```

If port `5432` is already in use:

```bash
lsof -i :5432
```

Stop the conflicting service or use another PostgreSQL URL.

If migrations are missing:

```bash
codebuddy migrate
```

If Claude Code does not show CodeBuddy tools:

- confirm `.mcp.json` is in the project root
- confirm `HF_TOKEN`, `DATABASE_URL`, and `CODEBUDDY_NAMESPACE`
- restart Claude Code

If Codex does not show CodeBuddy tools:

```bash
codebuddy codex list
```

Then restart Codex.

If model checks fail because a Hugging Face model is cold, gated, or rate-limited, run:

```bash
codebuddy doctor --skip-model-check
```

Database and MCP setup can still be valid even when live Hugging Face diagnostics are temporarily unavailable.
