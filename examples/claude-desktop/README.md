# Claude Desktop MCP Example

This example runs CodeBuddy as an MCP stdio server for Claude Desktop.

## Prerequisites

```bash
docker compose up -d
export DATABASE_URL=postgres://codebuddy:codebuddy@localhost:5432/codebuddy
export HF_TOKEN=hf_your_token
npm run build
node dist/cli/index.js init
node dist/cli/index.js doctor --skip-model-check
```

## Claude Desktop Config

Copy `claude_desktop_config.json` into your Claude Desktop MCP configuration location and replace `hf_replace_me` with your Hugging Face token.

The server command is:

```bash
npx codebuddy serve
```

For local development from this repository, use:

```json
{
  "mcpServers": {
    "codebuddy": {
      "command": "node",
      "args": ["/absolute/path/to/codebuddy/dist/cli/index.js", "serve"],
      "env": {
        "DATABASE_URL": "postgres://codebuddy:codebuddy@localhost:5432/codebuddy",
        "HF_TOKEN": "hf_your_token",
        "CODEBUDDY_NAMESPACE": "claude-desktop"
      }
    }
  }
}
```

## Available Tools

- `remember`
- `remember_batch`
- `recall`
- `list_facts`
- `list_namespaces`
- `forget`
- `share`

v0.1 intentionally ships MCP tools only over stdio. Resources, prompts, and HTTP transport are deferred.
