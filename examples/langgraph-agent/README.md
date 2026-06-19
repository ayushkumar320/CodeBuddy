# LangGraph Agent Example

This example shows CodeBuddy inside a LangGraph flow with recall before the agent step and remember after the agent step.

It demonstrates:

- `CodeBuddyNode` in `recall` mode
- `CodeBuddyNode` in `remember` mode
- `CodeBuddyCheckpointer`
- expected state fields: `messages`, `memory`, `sessionId`, `agentId`
- `cacheTtlSeconds: 30`

## Run

```bash
docker compose up -d
export DATABASE_URL=postgres://codebuddy:codebuddy@localhost:5432/codebuddy
export HF_TOKEN=hf_your_token
npm install
npm run build
npm install @langchain/langgraph @langchain/core
npx tsx examples/langgraph-agent/index.ts
```

The example imports from the public package surface:

```ts
import { createRuntime } from "codebuddy";
import { CodeBuddyCheckpointer, CodeBuddyNode } from "codebuddy/langgraph";
```

If Hugging Face is cold or rate-limited, the embedding worker may need time to prepare vectors. Recall still falls back to recent context while embeddings are pending.
