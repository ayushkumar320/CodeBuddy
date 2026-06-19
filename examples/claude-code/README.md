# Claude Code MCP Example

Use CodeBuddy as a Claude Code memory server through MCP stdio.

## Local Package Development

From this repository:

```bash
npm install
npm run build
docker compose up -d
```

Set your environment:

```bash
export DATABASE_URL=postgres://codebuddy:codebuddy@localhost:5432/codebuddy
export HF_TOKEN=hf_your_token
export CODEBUDDY_NAMESPACE=claude-code
```

Run a quick health check:

```bash
node dist/cli/index.js doctor --skip-model-check
```

## Project MCP Config

Add a `.mcp.json` file to the project where you use Claude Code:

```json
{
  "mcpServers": {
    "codebuddy": {
      "command": "node",
      "args": ["/absolute/path/to/codebuddy/dist/cli/index.js", "serve"],
      "env": {
        "DATABASE_URL": "postgres://codebuddy:codebuddy@localhost:5432/codebuddy",
        "HF_TOKEN": "hf_your_token",
        "CODEBUDDY_NAMESPACE": "claude-code"
      }
    }
  }
}
```

For an installed package, use:

```json
{
  "mcpServers": {
    "codebuddy": {
      "command": "codebuddy",
      "args": ["serve"],
      "env": {
        "DATABASE_URL": "postgres://codebuddy:codebuddy@localhost:5432/codebuddy",
        "HF_TOKEN": "hf_your_token",
        "CODEBUDDY_NAMESPACE": "claude-code"
      }
    }
  }
}
```

Restart Claude Code after adding or changing MCP config. The available tools are `remember`, `remember_batch`, `recall`, `list_facts`, `list_namespaces`, `forget`, and `share`.
