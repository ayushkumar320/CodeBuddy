import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodeBuddy } from "../../core/codebuddy.js";
import { loadPlanPolicy } from "../../core/config-file.js";
import { listFactsPage } from "../../core/operations.js";
import { PlanFileStore } from "../../core/plan-file-store.js";
import { PlanLifecycle } from "../../core/plan-lifecycle.js";
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

const plannedFileSchema = z.object({
  path: z.string().min(1),
  action: z.enum(["create", "edit", "delete"]),
  notes: z.string().optional(),
});
const plannedTestSchema = z.object({
  path: z.string().min(1),
  description: z.string().optional(),
});
const planPatchSchema = {
  title: z.string().min(1).optional(),
  brief: z.string().optional(),
  body: z.string().optional(),
  filesToTouch: z.array(plannedFileSchema).optional(),
  testsToAdd: z.array(plannedTestSchema).optional(),
  outOfScope: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
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
  plan_current: z.object({}),
  plan_create: z.object({
    title: z.string().min(1),
    brief: z.string().min(1),
    body: z.string().optional(),
    filesToTouch: z.array(plannedFileSchema).optional(),
    testsToAdd: z.array(plannedTestSchema).optional(),
    outOfScope: z.array(z.string()).optional(),
    risks: z.array(z.string()).optional(),
    agentId: z.string().optional(),
  }),
  plan_amend: z.object({ id: z.string().min(1), patch: z.object(planPatchSchema) }),
  plan_status: z.object({
    id: z.string().min(1),
    status: z.enum(["approved", "executing", "complete", "abandoned"]),
    commitSha: z.string().optional(),
    notes: z.string().optional(),
    reason: z.string().optional(),
  }),
} as const;

export type RegisterCodeBuddyToolsOptions = {
  memory: CodeBuddy;
  repository: MemoryRepository;
};

/** Cap plan bodies returned over MCP so a huge plan can't blow the context. */
const PLAN_BODY_LIMIT = 8_000;

function serializePlan(plan: import("../../core/plan-file-store.js").PlanSpec | null) {
  if (!plan) return { plan: null };
  const body =
    plan.body.length > PLAN_BODY_LIMIT
      ? `${plan.body.slice(0, PLAN_BODY_LIMIT)}\n\n…[truncated]`
      : plan.body;
  return { plan: { ...plan, body } };
}

export function registerCodeBuddyTools(server: McpServer, options: RegisterCodeBuddyToolsOptions) {
  const json = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  });

  const namespace = options.memory.config.namespace;
  const projectRoot = options.memory.config.projectRoot ?? process.cwd();
  const planStore = new PlanFileStore(projectRoot);
  const planLifecycle = new PlanLifecycle(planStore);
  const toFiles = (
    items?: Array<{
      path: string;
      action: "create" | "edit" | "delete";
      notes?: string | undefined;
    }>,
  ) => items?.map((item) => ({ path: item.path, action: item.action, notes: item.notes ?? "" }));
  const toTests = (items?: Array<{ path: string; description?: string | undefined }>) =>
    items?.map((item) => ({ path: item.path, description: item.description ?? "" }));

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

  // ── Plan tools (Proposal 02.6) ────────────────────────────────────
  server.registerTool(
    "plan_current",
    {
      title: "Current plan",
      description: "Return the active (approved or executing) plan for this namespace, or null.",
      inputSchema: mcpToolInputSchemas.plan_current.shape,
    },
    async () => {
      const [current, policy] = await Promise.all([
        planLifecycle.current(namespace),
        loadPlanPolicy(projectRoot),
      ]);
      return json({ ...serializePlan(current), policy });
    },
  );

  server.registerTool(
    "plan_create",
    {
      title: "Create plan",
      description: "Create a draft plan in this namespace.",
      inputSchema: mcpToolInputSchemas.plan_create.shape,
    },
    async (input) => {
      const files = toFiles(input.filesToTouch);
      const tests = toTests(input.testsToAdd);
      const created = await planLifecycle.create({
        namespace,
        title: input.title,
        brief: input.brief,
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(files ? { filesToTouch: files } : {}),
        ...(tests ? { testsToAdd: tests } : {}),
        ...(input.outOfScope !== undefined ? { outOfScope: input.outOfScope } : {}),
        ...(input.risks !== undefined ? { risks: input.risks } : {}),
        ...(input.agentId !== undefined ? { createdByAgent: input.agentId } : {}),
      });
      return json(serializePlan(created));
    },
  );

  server.registerTool(
    "plan_amend",
    {
      title: "Amend plan",
      description: "Amend a draft or executing plan's content fields.",
      inputSchema: mcpToolInputSchemas.plan_amend.shape,
    },
    async (input) => {
      const patch = input.patch;
      const files = toFiles(patch.filesToTouch);
      const tests = toTests(patch.testsToAdd);
      const amended = await planLifecycle.amend(input.id, {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.brief !== undefined ? { brief: patch.brief } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(files ? { filesToTouch: files } : {}),
        ...(tests ? { testsToAdd: tests } : {}),
        ...(patch.outOfScope !== undefined ? { outOfScope: patch.outOfScope } : {}),
        ...(patch.risks !== undefined ? { risks: patch.risks } : {}),
      });
      return json(serializePlan(amended));
    },
  );

  server.registerTool(
    "plan_status",
    {
      title: "Transition plan",
      description: "Move a plan through its lifecycle: approved, executing, complete, abandoned.",
      inputSchema: mcpToolInputSchemas.plan_status.shape,
    },
    async (input) => {
      let next: import("../../core/plan-file-store.js").PlanSpec;
      if (input.status === "approved") next = await planLifecycle.approve(input.id);
      else if (input.status === "executing") next = await planLifecycle.start(input.id);
      else if (input.status === "complete")
        next = await planLifecycle.complete(input.id, {
          ...(input.commitSha !== undefined ? { commitSha: input.commitSha } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        });
      else
        next = await planLifecycle.abandon(
          input.id,
          input.reason !== undefined ? { reason: input.reason } : {},
        );
      return json(serializePlan(next));
    },
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
