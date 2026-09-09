import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildBeforeEditContext, buildBootstrapContext } from "../../context/engine.js";
import type { CodeBuddy } from "../../core/codebuddy.js";
import { loadPlanPolicy } from "../../core/config-file.js";
import { listFactsPage } from "../../core/operations.js";
import { PlanFileStore } from "../../core/plan-file-store.js";
import { PlanLifecycle } from "../../core/plan-lifecycle.js";
import type { MemoryRepository } from "../../core/repository.js";
import type { RecallInput, RememberInput } from "../../core/types.js";
import { IndexStore } from "../../indexer/store.js";
import { loadArchitectureMap } from "../../map/cache.js";
import { buildArchitectureMap, neighbours, queryMap } from "../../map/indexer.js";
import { captureAfterTurn } from "../../memory-extract/engine.js";
import { assessRisk } from "../../risk/service.js";
import { generateSuggestions } from "../../suggest/engine.js";

/**
 * Input caps. The output side is bounded (LIMITS in the context engine,
 * list_facts ≤ 100); the input side must be too — one tool call should never
 * push megabytes of content into Postgres, the embedding queue, or a plan
 * file that later flows back into agent context.
 */
const INPUT_LIMITS = {
  contentChars: 32_000,
  batchItems: 100,
  summaryChars: 32_000,
  planBodyChars: 64_000,
  planBriefChars: 4_000,
  titleChars: 300,
  arrayItems: 100,
  pathChars: 1_024,
  taskChars: 2_000,
  agentIdChars: 200,
} as const;

const rememberSchema = {
  sessionId: z.string().min(1).max(200).optional(),
  content: z.string().min(1).max(INPUT_LIMITS.contentChars),
  type: z.enum(["interaction", "fact", "summary"]).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  agentId: z.string().min(1).max(INPUT_LIMITS.agentIdChars).optional(),
};

const recallSchema = {
  sessionId: z.string().min(1).max(200),
  query: z.string().min(1).max(INPUT_LIMITS.taskChars),
  budget: z.number().int().positive().optional(),
  callerModel: z.string().min(1).max(200).optional(),
  conflictMode: z.enum(["all", "latest", "highest_confidence"]).optional(),
};

const shareSchema = {
  from: z.string().min(1).max(INPUT_LIMITS.agentIdChars).optional(),
  to_namespace: z.string().min(1).max(INPUT_LIMITS.agentIdChars),
  factIds: z.array(z.string().min(1).max(100)).min(1).max(INPUT_LIMITS.arrayItems),
  mode: z.enum(["reference", "snapshot"]).optional(),
  agentId: z.string().min(1).max(INPUT_LIMITS.agentIdChars).optional(),
};

const plannedFileSchema = z.object({
  path: z.string().min(1).max(INPUT_LIMITS.pathChars),
  action: z.enum(["create", "edit", "delete"]),
  notes: z.string().max(INPUT_LIMITS.taskChars).optional(),
});
const plannedTestSchema = z.object({
  path: z.string().min(1).max(INPUT_LIMITS.pathChars),
  description: z.string().max(INPUT_LIMITS.taskChars).optional(),
});
const planPatchSchema = {
  title: z.string().min(1).max(INPUT_LIMITS.titleChars).optional(),
  brief: z.string().max(INPUT_LIMITS.planBriefChars).optional(),
  body: z.string().max(INPUT_LIMITS.planBodyChars).optional(),
  filesToTouch: z.array(plannedFileSchema).max(INPUT_LIMITS.arrayItems).optional(),
  testsToAdd: z.array(plannedTestSchema).max(INPUT_LIMITS.arrayItems).optional(),
  outOfScope: z
    .array(z.string().max(INPUT_LIMITS.pathChars))
    .max(INPUT_LIMITS.arrayItems)
    .optional(),
  risks: z.array(z.string().max(INPUT_LIMITS.taskChars)).max(INPUT_LIMITS.arrayItems).optional(),
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
    title: z.string().min(1).max(INPUT_LIMITS.titleChars),
    brief: z.string().min(1).max(INPUT_LIMITS.planBriefChars),
    body: z.string().max(INPUT_LIMITS.planBodyChars).optional(),
    filesToTouch: z.array(plannedFileSchema).max(INPUT_LIMITS.arrayItems).optional(),
    testsToAdd: z.array(plannedTestSchema).max(INPUT_LIMITS.arrayItems).optional(),
    outOfScope: z
      .array(z.string().max(INPUT_LIMITS.pathChars))
      .max(INPUT_LIMITS.arrayItems)
      .optional(),
    risks: z.array(z.string().max(INPUT_LIMITS.taskChars)).max(INPUT_LIMITS.arrayItems).optional(),
    agentId: z.string().min(1).max(INPUT_LIMITS.agentIdChars).optional(),
  }),
  plan_amend: z.object({ id: z.string().min(1), patch: z.object(planPatchSchema) }),
  plan_status: z.object({
    id: z.string().min(1),
    status: z.enum(["approved", "executing", "complete", "abandoned"]),
    commitSha: z.string().optional(),
    notes: z.string().optional(),
    reason: z.string().optional(),
  }),
  risk_assess: z.object({
    planId: z.string().min(1).max(100).optional(),
    paths: z
      .array(z.string().min(1).max(INPUT_LIMITS.pathChars))
      .max(INPUT_LIMITS.arrayItems)
      .optional(),
    useGit: z.boolean().optional(),
    limit: z.number().int().positive().max(100).optional(),
  }),
  map_query: z.object({
    from: z.string().min(1).max(INPUT_LIMITS.pathChars).optional(),
    to: z.string().min(1).max(INPUT_LIMITS.pathChars).optional(),
    limit: z.number().int().positive().max(100).optional(),
  }),
  map_neighbours: z.object({
    module: z.string().min(1).max(INPUT_LIMITS.pathChars),
    direction: z.enum(["in", "out", "both"]).default("both"),
  }),
  context_bootstrap: z.object({}),
  context_before_edit: z.object({
    task: z.string().min(1).max(INPUT_LIMITS.taskChars).optional(),
    paths: z
      .array(z.string().min(1).max(INPUT_LIMITS.pathChars))
      .max(INPUT_LIMITS.arrayItems)
      .optional(),
    planId: z.string().min(1).max(100).optional(),
    useGit: z.boolean().optional(),
    tokenBudget: z.number().int().positive().max(100_000).optional(),
  }),
  context_pack: z.object({
    task: z.string().min(1).max(INPUT_LIMITS.taskChars),
    paths: z
      .array(z.string().min(1).max(INPUT_LIMITS.pathChars))
      .max(INPUT_LIMITS.arrayItems)
      .optional(),
    planId: z.string().min(1).max(100).optional(),
    useGit: z.boolean().optional(),
    tokenBudget: z.number().int().positive().max(100_000).optional(),
  }),
  context_after_turn: z.object({
    summary: z.string().min(1).max(INPUT_LIMITS.summaryChars),
    changedFiles: z
      .array(z.string().min(1).max(INPUT_LIMITS.pathChars))
      .max(INPUT_LIMITS.arrayItems)
      .optional(),
    planId: z.string().min(1).max(100).optional(),
    taskType: z.string().min(1).max(100).optional(),
    agentId: z.string().min(1).max(INPUT_LIMITS.agentIdChars).optional(),
  }),
  code_suggestions: z.object({
    paths: z
      .array(z.string().min(1).max(INPUT_LIMITS.pathChars))
      .max(INPUT_LIMITS.arrayItems)
      .optional(),
    planId: z.string().min(1).max(100).optional(),
    useGit: z.boolean().optional(),
    limit: z.number().int().positive().max(100).optional(),
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

  server.registerTool(
    "risk_assess",
    {
      title: "Assess risk",
      description: "Assess evidence-backed risk for a plan, explicit paths, or git changes.",
      inputSchema: mcpToolInputSchemas.risk_assess.shape,
    },
    async (input) =>
      json(
        await assessRisk({
          repositoryRoot: projectRoot,
          namespace,
          ...(input.planId !== undefined ? { planId: input.planId } : {}),
          ...(input.paths !== undefined ? { paths: input.paths } : {}),
          ...(input.useGit !== undefined ? { useGit: input.useGit } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        }),
      ),
  );

  server.registerTool(
    "map_query",
    {
      title: "Query architecture map",
      description: "Query lightweight module import edges in the current repository.",
      inputSchema: mcpToolInputSchemas.map_query.shape,
    },
    async (input) => {
      const graph = await cachedMap();
      return json(
        queryMap(graph, {
          ...(input.from !== undefined ? { from: input.from } : {}),
          ...(input.to !== undefined ? { to: input.to } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        }),
      );
    },
  );

  server.registerTool(
    "map_neighbours",
    {
      title: "Module neighbours",
      description: "Return inbound/outbound neighbours for a repository module.",
      inputSchema: mcpToolInputSchemas.map_neighbours.shape,
    },
    async (input) => json(neighbours(await cachedMap(), input.module, input.direction)),
  );

  // ── Context engine tools (Proposal 04.2) ──────────────────────────
  const tokenBudget = options.memory.config.tokenBudget;

  /**
   * The map cache (`.codebuddy/cache/map.json`, refreshed by `codebuddy
   * index`/`watch`) is the same source the context engine uses. Rebuilding
   * the whole import graph per tool call wasted work and ignored incremental
   * updates; fall back to a fresh build only when no cache exists yet.
   */
  const cachedMap = async () => {
    const manifest = await new IndexStore(projectRoot).read();
    const cached = await loadArchitectureMap(projectRoot, manifest);
    if (cached.map.modules.length > 0) return cached.map;
    return buildArchitectureMap(projectRoot);
  };

  server.registerTool(
    "context_bootstrap",
    {
      title: "Bootstrap project context",
      description:
        "Return compact project awareness for the start of a turn: identity, active plan and policy, top policy rules, incident hotspots, and an architecture summary. Prefer this over a manual recall at session start.",
      inputSchema: mcpToolInputSchemas.context_bootstrap.shape,
    },
    async () =>
      json(
        await buildBootstrapContext({
          repositoryRoot: projectRoot,
          namespace,
          ...(tokenBudget !== undefined ? { tokenBudget } : {}),
        }),
      ),
  );

  server.registerTool(
    "context_before_edit",
    {
      title: "Context before edit",
      description:
        "Assemble relevant context before changing code: resolves target files from paths, a plan, or git, then returns the relevant plan, matching policy rules, incident memory, an evidence-backed risk assessment, and import neighbours.",
      inputSchema: mcpToolInputSchemas.context_before_edit.shape,
    },
    async (input) =>
      json(
        await buildBeforeEditContext({
          repositoryRoot: projectRoot,
          namespace,
          ...(input.task !== undefined ? { task: input.task } : {}),
          ...(input.paths !== undefined ? { paths: input.paths } : {}),
          ...(input.planId !== undefined ? { planId: input.planId } : {}),
          ...(input.useGit !== undefined ? { useGit: input.useGit } : {}),
          ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
          ...(tokenBudget !== undefined && input.tokenBudget === undefined ? { tokenBudget } : {}),
        }),
      ),
  );

  server.registerTool(
    "context_pack",
    {
      title: "Build task context pack",
      description:
        "Build the smallest useful context pack for a coding task. Automatically finds relevant files from the local index when paths are omitted, then includes only bounded symbols, policies, risks, incidents, architecture neighbours, and relevant team facts within the requested token budget. Use this once at the start of a task instead of manually chaining context, risk, map, and memory tools.",
      inputSchema: mcpToolInputSchemas.context_pack.shape,
    },
    async (input) =>
      json(
        await buildBeforeEditContext({
          repositoryRoot: projectRoot,
          namespace,
          task: input.task,
          ...(input.paths !== undefined ? { paths: input.paths } : {}),
          ...(input.planId !== undefined ? { planId: input.planId } : {}),
          ...(input.useGit !== undefined ? { useGit: input.useGit } : {}),
          tokenBudget: input.tokenBudget ?? tokenBudget ?? 4_000,
        }),
      ),
  );

  server.registerTool(
    "context_after_turn",
    {
      title: "Capture context after a turn",
      description:
        "Extract durable knowledge from a turn summary. Confident facts/decisions/incidents are auto-saved as Markdown; temporary notes, low-confidence, and sensitive items are queued for review under .codebuddy/memory/review/; chatter is ignored. Never saves sensitive content automatically.",
      inputSchema: mcpToolInputSchemas.context_after_turn.shape,
    },
    async (input) => {
      const result = await captureAfterTurn({
        summary: input.summary,
        namespace,
        ...(input.changedFiles !== undefined ? { changedFiles: input.changedFiles } : {}),
        ...(input.planId !== undefined ? { planId: input.planId } : {}),
        ...(input.taskType !== undefined ? { taskType: input.taskType } : {}),
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      });
      return json({
        saved: result.saved.map((d) => ({
          id: d.ref,
          class: d.candidate.class,
          subject: d.candidate.subject,
        })),
        queuedForReview: result.queuedForReview.map((d) => ({
          id: d.ref,
          class: d.candidate.class,
          reason: d.reason,
          sensitive: d.sensitive,
        })),
        ignored: result.ignored.length,
        reasons: result.reasons,
        extractor: result.extractor,
      });
    },
  );

  server.registerTool(
    "code_suggestions",
    {
      title: "Code suggestions",
      description:
        "Return read-only, evidence-backed code-quality suggestions for a change set (paths, a plan, or git). Composes risk, plan divergence, architecture blast radius, incident history, missing tests, and stale policies. Never edits code.",
      inputSchema: mcpToolInputSchemas.code_suggestions.shape,
    },
    async (input) =>
      json(
        await generateSuggestions({
          repositoryRoot: projectRoot,
          namespace,
          ...(input.paths !== undefined ? { paths: input.paths } : {}),
          ...(input.planId !== undefined ? { planId: input.planId } : {}),
          ...(input.useGit !== undefined ? { useGit: input.useGit } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
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
