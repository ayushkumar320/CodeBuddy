# CodeBuddy Setup For Claude And Codex

This guide shows how to run CodeBuddy from the CLI, connect it to PostgreSQL, and use it from Claude Desktop, Claude Code, and Codex with minimal manual work.

CodeBuddy is an MCP memory server. Once connected, Claude or Codex can use tools like `remember`, `recall`, `list_facts`, `forget`, and `share`.

## 1. Requirements

Install these first:

```bash
node --version
docker --version
```

You need:

- Node.js 20 or newer
- Docker Desktop
- A Hugging Face token

Get a Hugging Face token from:

```text
https://huggingface.co/settings/tokens
```

## 2. Build And Link CodeBuddy Locally

From the CodeBuddy repo:

```bash
cd /Users/ayush/Projects/codebuddy
npm install
npm run build
npm link
```

Check that the CLI is available:

```bash
codebuddy --help
```

If `codebuddy` is not found, run:

```bash
npm link
```

again from:

```bash
/Users/ayush/Projects/codebuddy
```

## 3. Recommended One-Command Setup For Any Project

Go to the project where you want Claude or Codex memory:

```bash
cd /path/to/your/project
```

Run:

```bash
codebuddy use
```

This command does most of the work automatically:

- Uses the current folder name as the memory namespace
- Asks for your Hugging Face token the first time
- Saves reusable settings in `~/.codebuddy/global.json`
- Uses local PostgreSQL at `postgres://codebuddy:codebuddy@localhost:5432/codebuddy`
- Starts the bundled Docker PostgreSQL container if needed
- Enables `pgvector`
- Runs database migrations
- Registers CodeBuddy in Claude Desktop
- Registers CodeBuddy in Codex

After it finishes, restart Claude Desktop and Codex.

## 4. Use A Custom Namespace

By default, CodeBuddy uses the current folder name as the namespace.

Example:

```bash
cd ~/Projects/my-app
codebuddy use
```

This creates an MCP server named something like:

```text
codebuddy-my-app
```

To choose your own namespace:

```bash
codebuddy use my-custom-namespace
```

## 5. Use Your Own PostgreSQL Database

If you already have PostgreSQL running, pass your database URL:

```bash
codebuddy use --postgres-url "postgres://USER:PASSWORD@HOST:5432/DB_NAME"
```

Example:

```bash
codebuddy use --postgres-url "postgres://codebuddy:codebuddy@localhost:5432/codebuddy"
```

For a remote database:

```bash
codebuddy use --postgres-url "postgres://myuser:mypassword@db.example.com:5432/mydb"
```

Your PostgreSQL database must support `pgvector`.

## 6. Local Docker PostgreSQL Commands

Start the bundled PostgreSQL database:

```bash
codebuddy postgres up
```

Check status:

```bash
codebuddy postgres status
```

Stop PostgreSQL:

```bash
codebuddy postgres down
```

Stopping preserves the Docker volume. Your memory data is not deleted.

The default database URL is:

```text
postgres://codebuddy:codebuddy@localhost:5432/codebuddy
```

## 7. Run Migrations Manually

Usually `codebuddy use` handles this automatically.

If you need to run migrations manually:

```bash
codebuddy migrate
```

## 8. Health Check

Run:

```bash
codebuddy doctor
```

This checks:

- Database connectivity
- `pgvector`
- Vector/index status
- Recent usage
- Config permissions

To skip Hugging Face model checks:

```bash
codebuddy doctor --skip-model-check
```

## 9. Claude Desktop Setup

The automatic way:

```bash
cd /path/to/your/project
codebuddy use
```

Then fully quit and reopen Claude Desktop.

On macOS:

```bash
osascript -e 'quit app "Claude"'
open -a Claude
```

Check registered Claude entries:

```bash
codebuddy claude list
```

Install only Claude Desktop integration manually:

```bash
codebuddy claude install --namespace my-project
```

Remove a Claude Desktop integration:

```bash
codebuddy claude remove codebuddy-my-project
```

Claude Desktop config location on macOS:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

The generated entry looks like this:

```json
{
  "mcpServers": {
    "codebuddy-my-project": {
      "command": "node",
      "args": ["/absolute/path/to/codebuddy/dist/cli/index.js", "serve"],
      "env": {
        "DATABASE_URL": "postgres://codebuddy:codebuddy@localhost:5432/codebuddy",
        "HF_TOKEN": "hf_your_token",
        "CODEBUDDY_NAMESPACE": "my-project"
      }
    }
  }
}
```

You should not need to edit this manually when using:

```bash
codebuddy use
```

## 10. Claude Code Setup

Claude Code usually uses a project-level `.mcp.json`.

From the project where you use Claude Code:

```bash
cd /path/to/your/project
```

Create `.mcp.json`:

```bash
touch .mcp.json
```

Use this content:

```json
{
  "mcpServers": {
    "codebuddy": {
      "command": "node",
      "args": ["/Users/ayush/Projects/codebuddy/dist/cli/index.js", "serve"],
      "env": {
        "DATABASE_URL": "postgres://codebuddy:codebuddy@localhost:5432/codebuddy",
        "HF_TOKEN": "hf_your_token",
        "CODEBUDDY_NAMESPACE": "my-project"
      }
    }
  }
}
```

Replace:

```text
hf_your_token
```

with your real Hugging Face token.

Replace:

```text
my-project
```

with the namespace you want for that project.

If CodeBuddy is globally linked with `npm link`, this shorter version can also work:

```json
{
  "mcpServers": {
    "codebuddy": {
      "command": "codebuddy",
      "args": ["serve"],
      "env": {
        "DATABASE_URL": "postgres://codebuddy:codebuddy@localhost:5432/codebuddy",
        "HF_TOKEN": "hf_your_token",
        "CODEBUDDY_NAMESPACE": "my-project"
      }
    }
  }
}
```

Restart Claude Code after changing `.mcp.json`.

## 11. Codex Setup

The automatic way:

```bash
cd /path/to/your/project
codebuddy use
```

Then restart Codex.

Check registered Codex entries:

```bash
codebuddy codex list
```

Install only Codex integration manually:

```bash
codebuddy codex install --namespace my-project
```

Remove a Codex integration:

```bash
codebuddy codex remove codebuddy-my-project
```

Codex config location:

```text
~/.codex/config.toml
```

The generated entry looks like this:

```toml
[mcp_servers."codebuddy-my-project"]
command = "node"
args = ["/Users/ayush/Projects/codebuddy/dist/cli/index.js", "serve"]

[mcp_servers."codebuddy-my-project".env]
CODEBUDDY_NAMESPACE = "my-project"
DATABASE_URL = "postgres://codebuddy:codebuddy@localhost:5432/codebuddy"
HF_TOKEN = "hf_your_token"
```

You should not need to edit this manually when using:

```bash
codebuddy use
```

## 12. Skipping Claude Or Codex

Set up only Codex:

```bash
codebuddy use --skip-claude
```

Set up only Claude Desktop:

```bash
codebuddy use --skip-codex
```

Set up database and migrations without either app:

```bash
codebuddy use --skip-claude --skip-codex
```

## 13. Using Memory In Claude Or Codex

After setup and restart, ask Claude or Codex things like:

```text
Remember that this project uses PostgreSQL with pgvector for agent memory.
```

```text
Recall what you know about this project setup.
```

```text
List the facts you remember for this project.
```

```text
Forget the fact about the old database URL.
```

Available MCP tools:

- `remember`
- `remember_batch`
- `recall`
- `list_facts`
- `list_namespaces`
- `forget`
- `share`

## 14. Inspect Memory From The CLI

List namespaces:

```bash
codebuddy namespaces
```

Inspect one namespace:

```bash
codebuddy inspect my-project
```

List facts:

```bash
codebuddy list-facts
```

Export facts:

```bash
codebuddy export my-project > codebuddy-memory.json
```

Show stats:

```bash
codebuddy stats
```

Prune old memory:

```bash
codebuddy prune --older-than 30d
```

## 15. Efficient Daily Workflow

For each new project:

```bash
cd /path/to/project
codebuddy use
```

Then restart Claude Desktop and Codex.

After that, just work normally and ask the assistant to remember important project facts.

Good examples:

```text
Remember the local dev command is npm run dev.
```

```text
Remember that production uses the Supabase database, but local dev uses Docker Postgres.
```

```text
Remember our auth flow lives in src/auth and uses JWT cookies.
```

Use recall when starting a new session:

```text
Recall the key setup details and conventions for this project before making changes.
```

## 16. Troubleshooting

If `codebuddy` is not found:

```bash
cd /Users/ayush/Projects/codebuddy
npm link
```

If the database is not reachable:

```bash
codebuddy postgres up
codebuddy doctor
```

If Docker is not running:

```bash
open -a Docker
```

Then:

```bash
codebuddy postgres up
```

If migrations are missing:

```bash
codebuddy migrate
```

If Claude Desktop does not show CodeBuddy tools:

```bash
codebuddy claude list
osascript -e 'quit app "Claude"'
open -a Claude
```

If Codex does not show CodeBuddy tools:

```bash
codebuddy codex list
```

Then fully restart Codex.

If you changed the CodeBuddy source code:

```bash
cd /Users/ayush/Projects/codebuddy
npm run build
npm link
```

Then restart Claude Desktop and Codex.

## 17. Files Created Or Updated

Global reusable CodeBuddy config:

```text
~/.codebuddy/global.json
```

Claude Desktop MCP config:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

Codex MCP config:

```text
~/.codex/config.toml
```

Optional Claude Code project config:

```text
/path/to/your/project/.mcp.json
```

Local Docker Postgres volume:

```text
codebuddy-postgres-data
```

## 18. Fast Start Summary

First-time setup:

```bash
cd /Users/ayush/Projects/codebuddy
npm install
npm run build
npm link
```

Per project:

```bash
cd /path/to/your/project
codebuddy use
```

Restart apps:

```bash
osascript -e 'quit app "Claude"'
open -a Claude
```

Then restart Codex manually.

Verify:

```bash
codebuddy doctor
codebuddy claude list
codebuddy codex list
```
