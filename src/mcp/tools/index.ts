import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodeBuddy } from "../../core/codebuddy.js";
import { listFactsPage } from "../../core/operations.js";
import type { MemoryRepository } from "../../core/repository.js";
import type { RecallInput, RememberInput } from "../../core/types.js";

const rememberSchema = {
  sessionId: z.string().optional(),
  content: z.string().min(1),
  type: z.enum(["interaction", "fact", "summary"]).optional(),
  idempotencyKey: z.string().optional(),
  agentId: z.string().optional(),
};

const recallSchema = {
  sessionId: z.string().min(1),
  query: z.string().min(1),
  budget: z.number().int().positive().optional(),
  callerModel: z.string().optional(),
  conflictMode: z.enum(["all", "latest", "highest_confidence"]).optional(),
};

const shareSchema = {
  from: z.string().optional(),
  to_namespace: z.string().min(1),
  factIds: z.array(z.string().min(1)).min(1),
  mode: z.enum(["reference", "snapshot"]).optional(),
  agentId: z.string().optional(),
};

export const mcpToolInputSchemas = {
  remember: z.object(rememberSchema),
  remember_batch: z.object({ items: z.array(z.object(rememberSchema)).min(1) }),
  recall: z.object(recallSchema),
  list_facts: z.object({
    subject: z.string().optional(),
    limit: z.number().int().positive().max(100).default(50),
    cursor: z.string().optional(),
  }),
  list_namespaces: z.object({}),
  forget: z.object({ id: z.string().min(1) }),
  share: z.object(shareSchema),
} as const;

export type RegisterCodeBuddyToolsOptions = {
  memory: CodeBuddy;
  repository: MemoryRepository;
};

export function registerCodeBuddyTools(server: McpServer, options: RegisterCodeBuddyToolsOptions) {
  const json = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  });

  server.registerTool(
    "remember",
    {
      title: "Remember",
      description: "Store one CodeBuddy memory item.",
      inputSchema: mcpToolInputSchemas.remember.shape,
    },
    async (input) => json(await options.memory.remember(toRememberInput(input))),
  );

  server.registerTool(
    "remember_batch",
    {
      title: "Remember batch",
      description: "Store multiple CodeBuddy memory items.",
      inputSchema: mcpToolInputSchemas.remember_batch.shape,
    },
    async (input) =>
      json({ items: await options.memory.rememberBatch(input.items.map(toRememberInput)) }),
  );

  server.registerTool(
    "recall",
    {
      title: "Recall",
      description: "Recall prompt-ready CodeBuddy context.",
      inputSchema: mcpToolInputSchemas.recall.shape,
    },
    async (input) => json(await options.memory.recall(toRecallInput(input))),
  );

  server.registerTool(
    "list_facts",
    {
      title: "List facts",
      description: "List facts in the configured namespace.",
      inputSchema: mcpToolInputSchemas.list_facts.shape,
    },
    async (input) =>
      json(
        await listFactsPage(
          options.memory,
          options.repository,
          cleanOptional(input) as { subject?: string; limit?: number; cursor?: string },
        ),
      ),
  );

  server.registerTool(
    "list_namespaces",
    {
      title: "List namespaces",
      description: "List CodeBuddy namespaces.",
      inputSchema: mcpToolInputSchemas.list_namespaces.shape,
    },
    async () => json({ namespaces: await options.repository.listNamespaces() }),
  );

  server.registerTool(
    "forget",
    {
      title: "Forget",
      description: "Delete an interaction or fact by id.",
      inputSchema: mcpToolInputSchemas.forget.shape,
    },
    async (input) => json(await options.memory.forget(input.id)),
  );

  server.registerTool(
    "share",
    {
      title: "Share",
      description: "Share facts from the configured namespace to another namespace.",
      inputSchema: mcpToolInputSchemas.share.shape,
    },
    async (input) =>
      json(
        await options.memory.share({
          from: input.from ?? options.memory.config.namespace,
          to: input.to_namespace,
          factIds: input.factIds,
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.agentId ? { agentId: input.agentId } : {}),
        }),
      ),
  );
}

function toRememberInput(input: z.infer<typeof mcpToolInputSchemas.remember>): RememberInput {
  return cleanOptional(input) as RememberInput;
}

function toRecallInput(input: z.infer<typeof mcpToolInputSchemas.recall>): RecallInput {
  return cleanOptional(input) as RecallInput;
}

function cleanOptional(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
