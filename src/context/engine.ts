import { join, resolve } from "node:path";
import { loadPlanPolicy } from "../core/config-file.js";
import { type IncidentFactFile, MemoryFileStore } from "../core/memory-file-store.js";
import { PlanFileStore, type PlanSpec } from "../core/plan-file-store.js";
import { PlanLifecycle } from "../core/plan-lifecycle.js";
import { buildArchitectureMap } from "../map/indexer.js";
import type { ArchitectureMap } from "../map/types.js";
import { assessRisk, resolveRiskPaths } from "../risk/service.js";
import { matchesPolicyGlob, type PolicyRule, readPolicyFile } from "../risk/signals/policy.js";
import type {
  ArchitectureSummary,
  BeforeEditContext,
  BootstrapContext,
  IncidentSummary,
  ModuleNeighbours,
  PathSource,
  PlanSummary,
  PolicyRuleSummary,
  TokenStats,
} from "./types.js";

/**
 * Bounds. These keep both tool outputs compact regardless of repository size —
 * a bootstrap or before-edit payload should orient the agent, not dump the
 * whole project. Tune here rather than at each call site.
 */
const LIMITS = {
  bootstrapIncidents: 5,
  beforeEditIncidents: 8,
  policyRules: 5,
  hotspots: 5,
  neighbourPaths: 10,
  neighbourEdges: 10,
  incidentSummaryChars: 140,
} as const;

const DEFAULT_TOKEN_BUDGET = 4_000;
const SAVINGS_PLACEHOLDER =
  "Token savings accounting arrives in Phase 04.5; returnedEstimate reflects this payload only.";

export type BootstrapInput = {
  repositoryRoot?: string;
  namespace: string;
  tokenBudget?: number;
};

export type BeforeEditInput = {
  repositoryRoot?: string;
  namespace: string;
  task?: string;
  paths?: string[];
  planId?: string;
  useGit?: boolean;
  tokenBudget?: number;
};

/**
 * Assemble compact project awareness for the start of a turn: identity, the
 * active plan and policy, top policy rules, incident hotspots, and a
 * lightweight architecture summary. No edit target is required.
 */
export async function buildBootstrapContext(input: BootstrapInput): Promise<BootstrapContext> {
  const repositoryRoot = resolve(input.repositoryRoot ?? process.cwd());
  const namespace = input.namespace;

  const planStore = new PlanFileStore(repositoryRoot);
  const memoryStore = new MemoryFileStore(repositoryRoot);

  const [activePlan, policy, policyFile, incidents, map] = await Promise.all([
    new PlanLifecycle(planStore).current(namespace),
    loadPlanPolicy(repositoryRoot),
    readPolicyFile(join(repositoryRoot, ".codebuddy", "policies.yaml")),
    memoryStore.listIncidentFacts({ namespace }),
    buildArchitectureMap(repositoryRoot),
  ]);

  const explain: string[] = [];
  const plan = summarizePlan(activePlan);
  explain.push(plan ? `plan: active plan ${plan.id} (${plan.status})` : "plan: no active plan");
  explain.push(`policy: plan policy is "${policy}"`);

  const policyRules = summarizePolicyRules(policyFile.rules);
  if (policyRules.length > 0) explain.push(`policyRules: ${policyRules.length} rule(s) by weight`);

  const incidentSummaries = incidents.slice(0, LIMITS.bootstrapIncidents).map(summarizeIncident);
  if (incidentSummaries.length > 0) {
    explain.push(`incidents: ${incidentSummaries.length} unresolved incident hotspot(s)`);
  }

  const architecture = summarizeArchitecture(map);
  explain.push(
    `architecture: ${architecture.moduleCount} module(s), ${architecture.edgeCount} edge(s)`,
  );

  const partial = {
    project: { namespace, root: repositoryRoot },
    plan,
    policy,
    policyRules,
    incidents: incidentSummaries,
    architecture,
    explain,
  };
  return { ...partial, tokens: buildTokenStats(partial, input.tokenBudget) };
}

/**
 * Assemble the most relevant context before an edit: resolve the target files
 * (explicit paths, a plan, or git), then attach the relevant plan, policy
 * rules, incident memory for those files, an evidence-backed risk assessment,
 * and the import neighbours of each target.
 */
export async function buildBeforeEditContext(input: BeforeEditInput): Promise<BeforeEditContext> {
  const repositoryRoot = resolve(input.repositoryRoot ?? process.cwd());
  const namespace = input.namespace;

  const targetPaths = await resolveRiskPaths({
    repositoryRoot,
    ...(input.paths !== undefined ? { paths: input.paths } : {}),
    ...(input.planId !== undefined ? { planId: input.planId } : {}),
    ...(input.useGit !== undefined ? { useGit: input.useGit } : {}),
  });
  const pathSource = classifyPathSource(input, targetPaths.length);

  const planStore = new PlanFileStore(repositoryRoot);
  const memoryStore = new MemoryFileStore(repositoryRoot);

  const [referencedPlan, policy, policyFile, incidents, risks, map] = await Promise.all([
    resolveRelevantPlan(planStore, namespace, input.planId),
    loadPlanPolicy(repositoryRoot),
    readPolicyFile(join(repositoryRoot, ".codebuddy", "policies.yaml")),
    memoryStore.findIncidentFactsForPaths({ namespace, paths: targetPaths }),
    assessRisk({
      repositoryRoot,
      namespace,
      ...(input.paths !== undefined ? { paths: input.paths } : {}),
      ...(input.planId !== undefined ? { planId: input.planId } : {}),
      ...(input.useGit !== undefined ? { useGit: input.useGit } : {}),
    }),
    buildArchitectureMap(repositoryRoot),
  ]);

  const explain: string[] = [];
  explain.push(`paths: ${targetPaths.length} target(s) resolved from ${pathSource}`);

  const plan = summarizePlan(referencedPlan);
  if (plan) explain.push(`plan: ${plan.id} (${plan.status})`);

  const policyRules = summarizeMatchingPolicyRules(policyFile.rules, targetPaths);
  if (policyRules.length > 0) {
    explain.push(`policyRules: ${policyRules.length} rule(s) match target paths`);
  }

  const incidentSummaries = incidents.slice(0, LIMITS.beforeEditIncidents).map(summarizeIncident);
  if (incidentSummaries.length > 0) {
    explain.push(`incidents: ${incidentSummaries.length} incident(s) touch target paths`);
  }

  if (risks.items.length > 0) explain.push(`risks: ${risks.items.length} scored path(s)`);

  const neighbours = computeNeighbours(map, targetPaths);
  if (neighbours.length > 0)
    explain.push(`neighbours: import graph for ${neighbours.length} file(s)`);

  const partial = {
    project: { namespace, root: repositoryRoot },
    task: input.task ?? null,
    targetPaths,
    pathSource,
    plan,
    policy,
    policyRules,
    incidents: incidentSummaries,
    risks,
    neighbours,
    explain,
  };
  return { ...partial, tokens: buildTokenStats(partial, input.tokenBudget) };
}

// ── helpers ─────────────────────────────────────────────────────────

function summarizePlan(plan: PlanSpec | null): PlanSummary {
  if (!plan) return null;
  return {
    id: plan.id,
    title: plan.title,
    status: plan.status,
    brief: plan.brief,
    filesToTouch: plan.filesToTouch.map((file) => file.path),
    risks: plan.risks,
  };
}

/**
 * Prefer an explicitly referenced plan; fall back to the namespace's active
 * plan so before-edit context stays useful even when the caller passes only
 * paths.
 */
async function resolveRelevantPlan(
  store: PlanFileStore,
  namespace: string,
  planId?: string,
): Promise<PlanSpec | null> {
  if (planId) {
    try {
      return await store.readPlan(planId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  return new PlanLifecycle(store).current(namespace);
}

function summarizeIncident(fact: IncidentFactFile): IncidentSummary {
  return {
    id: fact.id,
    severity: fact.severity,
    subject: fact.subject,
    summary: truncate(fact.content || fact.object || fact.subject, LIMITS.incidentSummaryChars),
    paths: fact.paths,
    resolved: fact.resolvedBy !== null,
    createdAt: fact.createdAt,
  };
}

function summarizePolicyRules(rules: PolicyRule[]): PolicyRuleSummary[] {
  return [...rules]
    .sort((left, right) => right.weight - left.weight)
    .slice(0, LIMITS.policyRules)
    .map((rule) => ({
      id: rule.id,
      pattern: rule.pattern,
      message: rule.message ?? rule.reason ?? `Policy rule ${rule.id}.`,
      weight: rule.weight,
    }));
}

function summarizeMatchingPolicyRules(rules: PolicyRule[], paths: string[]): PolicyRuleSummary[] {
  const matching = rules.filter((rule) =>
    paths.some((path) => matchesPolicyGlob(path, rule.pattern)),
  );
  return summarizePolicyRules(matching);
}

function summarizeArchitecture(map: ArchitectureMap): ArchitectureSummary {
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  for (const edge of map.edges) {
    outbound.set(edge.from, (outbound.get(edge.from) ?? 0) + 1);
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
  }

  const hotspots = map.modules
    .map((module) => ({
      path: module.path,
      inbound: inbound.get(module.path) ?? 0,
      outbound: outbound.get(module.path) ?? 0,
    }))
    .filter((entry) => entry.inbound + entry.outbound > 0)
    .sort((left, right) => {
      const degree = right.inbound + right.outbound - (left.inbound + left.outbound);
      if (degree !== 0) return degree;
      return left.path.localeCompare(right.path);
    })
    .slice(0, LIMITS.hotspots);

  return { moduleCount: map.modules.length, edgeCount: map.edges.length, hotspots };
}

function computeNeighbours(map: ArchitectureMap, paths: string[]): ModuleNeighbours[] {
  const result: ModuleNeighbours[] = [];
  for (const path of paths.slice(0, LIMITS.neighbourPaths)) {
    const dependsOn = map.edges
      .filter((edge) => edge.from === path)
      .map((edge) => edge.to)
      .slice(0, LIMITS.neighbourEdges);
    const dependedOnBy = map.edges
      .filter((edge) => edge.to === path)
      .map((edge) => edge.from)
      .slice(0, LIMITS.neighbourEdges);
    if (dependsOn.length === 0 && dependedOnBy.length === 0) continue;
    result.push({
      path,
      dependsOn: [...new Set(dependsOn)],
      dependedOnBy: [...new Set(dependedOnBy)],
    });
  }
  return result;
}

function classifyPathSource(input: BeforeEditInput, resolvedCount: number): PathSource {
  if (resolvedCount === 0) return "none";
  if (input.paths && input.paths.length > 0) return "paths";
  if (input.planId) return "plan";
  return "git";
}

/**
 * Estimate the token footprint of everything the tool returns except the token
 * stats themselves (~4 characters per token). This is deliberately rough — it
 * exists so future packing can measure payloads, not to bill anyone.
 */
function buildTokenStats(payload: unknown, tokenBudget?: number): TokenStats {
  const budget = tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const returnedEstimate = Math.ceil(JSON.stringify(payload ?? {}).length / 4);
  return {
    budget,
    returnedEstimate,
    savings: { available: false, note: SAVINGS_PLACEHOLDER },
  };
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
