import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadPlanPolicy, readConfigFile } from "../core/config-file.js";
import {
  type FactFile,
  type IncidentFactFile,
  MemoryFileStore,
} from "../core/memory-file-store.js";
import { PlanFileStore, type PlanSpec } from "../core/plan-file-store.js";
import { PlanLifecycle } from "../core/plan-lifecycle.js";
import { indexRepository } from "../indexer/engine.js";
import { IndexStore } from "../indexer/store.js";
import { extractSymbolTable, supportsSymbols, symbolSignatures } from "../indexer/symbols.js";
import type { IndexManifest } from "../indexer/types.js";
import { graphifyGraphExists } from "../integrations/graphify.js";
import { loadArchitectureMap } from "../map/cache.js";
import { loadGraphifyMap } from "../map/graphify.js";
import type { ArchitectureMap } from "../map/types.js";
import { assessRisk, resolveRiskPaths } from "../risk/service.js";
import { matchesPolicyGlob, type PolicyRule, readPolicyFile } from "../risk/signals/policy.js";
import { computeSavings } from "../savings/engine.js";
import { estimateTokens } from "../savings/tokens.js";
import type { StageStat } from "../savings/types.js";
import type {
  ArchitectureSummary,
  BeforeEditContext,
  BootstrapContext,
  DiffHunk,
  IncidentSummary,
  ModuleNeighbours,
  PathSource,
  PlanSummary,
  PolicyRuleSummary,
  RelevantFactSummary,
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
  symbolFiles: 10,
  symbolsPerFile: 12,
  relevantFacts: 5,
} as const;

const DEFAULT_TOKEN_BUDGET = 4_000;
const MAX_DIFF_FILES = 8;
const MAX_DIFF_CHARS_PER_FILE = 2_400;
const execFileAsync = promisify(execFile);

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
  semanticRanker?: SemanticRelevanceRanker;
};

export type SemanticRelevanceRanker = (
  task: string,
  candidates: Array<{ id: string; text: string }>,
) => Promise<Record<string, number>>;

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
  const manifestPromise = new IndexStore(repositoryRoot).read();
  const mapPromise = loadProjectArchitectureMap(repositoryRoot, manifestPromise);

  const [activePlan, policy, policyFile, incidents, facts, manifest, map] = await Promise.all([
    new PlanLifecycle(planStore).current(namespace),
    loadPlanPolicy(repositoryRoot),
    readPolicyFile(join(repositoryRoot, ".codebuddy", "policies.yaml")),
    memoryStore.listIncidentFacts({ namespace }),
    memoryStore.listFacts(),
    manifestPromise,
    mapPromise,
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

  const bootstrapFacts = await rankRelevantFacts(facts, namespace, "", []);
  const assembled = {
    project: { namespace, root: repositoryRoot },
    plan,
    policy,
    policyRules,
    incidents: incidentSummaries,
    facts: bootstrapFacts,
    architecture,
    explain,
  };
  const partial = enforceBootstrapBudget(assembled, input.tokenBudget ?? DEFAULT_TOKEN_BUDGET);
  if (partial.explain.some((entry) => entry.startsWith("budget: omitted"))) {
    explain.push(...partial.explain.filter((entry) => entry.startsWith("budget: omitted")));
  }
  const tokens = await buildTokenStats(
    repositoryRoot,
    partial,
    architecture.hotspots.map((hotspot) => hotspot.path),
    input.tokenBudget,
    manifest,
  );
  return { ...partial, tokens };
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

  const resolvedPaths = await resolveRiskPaths({
    repositoryRoot,
    ...(input.paths !== undefined ? { paths: input.paths } : {}),
    ...(input.planId !== undefined ? { planId: input.planId } : {}),
    ...(input.useGit !== undefined ? { useGit: input.useGit } : {}),
  });
  const taskPaths =
    resolvedPaths.length === 0 && input.task
      ? await discoverTaskPaths(repositoryRoot, input.task)
      : [];
  const targetPaths = taskPaths.length > 0 ? taskPaths : resolvedPaths;
  const discoveredFromTask = taskPaths.length > 0;
  const pathSource = classifyPathSource(input, targetPaths.length, discoveredFromTask);

  const planStore = new PlanFileStore(repositoryRoot);
  const memoryStore = new MemoryFileStore(repositoryRoot);
  const manifestPromise = new IndexStore(repositoryRoot).read();
  const mapPromise = loadProjectArchitectureMap(repositoryRoot, manifestPromise);

  const [referencedPlan, policy, policyFile, incidents, facts, risks, manifest, map, diffs] =
    await Promise.all([
      resolveRelevantPlan(planStore, namespace, input.planId),
      loadPlanPolicy(repositoryRoot),
      readPolicyFile(join(repositoryRoot, ".codebuddy", "policies.yaml")),
      memoryStore.findIncidentFactsForPaths({ namespace, paths: targetPaths }),
      memoryStore.listFacts(),
      assessRisk({
        repositoryRoot,
        namespace,
        ...(discoveredFromTask
          ? { paths: targetPaths }
          : input.paths !== undefined
            ? { paths: input.paths }
            : {}),
        ...(input.planId !== undefined ? { planId: input.planId } : {}),
        ...(discoveredFromTask
          ? { useGit: false }
          : input.useGit !== undefined
            ? { useGit: input.useGit }
            : {}),
      }),
      manifestPromise,
      mapPromise,
      input.useGit === false
        ? Promise.resolve([] as DiffHunk[])
        : readGitDiffs(repositoryRoot, targetPaths),
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

  const symbols = await computeTargetSymbols(repositoryRoot, targetPaths, input.task, manifest);
  if (symbols.length > 0)
    explain.push(
      `symbols: signatures for ${symbols.length} target file(s) (in place of full source)`,
    );

  const relevantFacts = await rankRelevantFacts(
    facts,
    namespace,
    input.task ?? "",
    targetPaths,
    input.semanticRanker,
  );
  if (relevantFacts.length > 0) {
    explain.push(`facts: ${relevantFacts.length} durable fact(s) ranked by task/path relevance`);
  }

  const assembled = {
    project: { namespace, root: repositoryRoot },
    task: input.task ?? null,
    targetPaths,
    pathSource,
    plan,
    policy,
    policyRules,
    incidents: incidentSummaries,
    facts: relevantFacts,
    risks,
    neighbours,
    symbols,
    diffs,
    explain,
  };
  const partial = enforceBeforeEditBudget(assembled, input.tokenBudget ?? DEFAULT_TOKEN_BUDGET);
  // The context stands in for the target files and their import neighbours —
  // exactly what an agent would otherwise open and read.
  const representedPaths = [
    ...new Set([
      ...targetPaths,
      ...neighbours.flatMap((n) => [n.path, ...n.dependsOn, ...n.dependedOnBy]),
    ]),
  ];
  const tokens = await buildTokenStats(
    repositoryRoot,
    partial,
    representedPaths,
    input.tokenBudget,
    manifest,
  );
  return { ...partial, tokens };
}

/**
 * Enforce budgets before token statistics are attached. Mandatory identity and
 * path fields form the minimal envelope; optional sections are removed from
 * lowest to highest value until the serialized context fits.
 */
function enforceBootstrapBudget<T extends Omit<BootstrapContext, "tokens">>(
  input: T,
  budget: number,
): T {
  const output = structuredClone(input);
  const omitted: string[] = [];
  const fits = () => estimateTokens(output) <= budget;
  const drop = (name: string, action: () => void) => {
    if (fits()) return;
    action();
    omitted.push(name);
  };
  drop("architecture hotspots", () => {
    output.architecture.hotspots = [];
  });
  drop("general facts", () => {
    output.facts = [];
  });
  drop("active plan", () => {
    output.plan = null;
  });
  drop("incidents", () => {
    output.incidents = [];
  });
  drop("policy rules", () => {
    output.policyRules = [];
  });
  if (!fits()) output.explain = [];
  else if (omitted.length > 0) output.explain.push(`budget: omitted ${omitted.join(", ")}`);
  if (!fits()) output.explain = [];
  return output;
}

function enforceBeforeEditBudget<T extends Omit<BeforeEditContext, "tokens">>(
  input: T,
  budget: number,
): T {
  const output = structuredClone(input);
  const omitted: string[] = [];
  const fits = () => estimateTokens(output) <= budget;
  const drop = (name: string, action: () => void) => {
    if (fits()) return;
    action();
    omitted.push(name);
  };
  drop("diff hunks", () => {
    output.diffs = [];
  });
  drop("import neighbours", () => {
    output.neighbours = [];
  });
  drop("risk detail", () => {
    output.risks.items = [];
  });
  drop("general facts", () => {
    output.facts = [];
  });
  drop("symbols", () => {
    output.symbols = [];
  });
  drop("active plan", () => {
    output.plan = null;
  });
  drop("incidents", () => {
    output.incidents = [];
  });
  drop("policy rules", () => {
    output.policyRules = [];
  });
  if (!fits()) output.explain = [];
  else if (omitted.length > 0) output.explain.push(`budget: omitted ${omitted.join(", ")}`);
  if (!fits()) output.explain = [];
  return output;
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
    // Dedupe BEFORE slicing: duplicate edges from a many-to-many import would
    // otherwise crowd unique neighbours out of the bounded payload.
    const dependsOn = [
      ...new Set(map.edges.filter((edge) => edge.from === path).map((edge) => edge.to)),
    ].slice(0, LIMITS.neighbourEdges);
    const dependedOnBy = [
      ...new Set(map.edges.filter((edge) => edge.to === path).map((edge) => edge.from)),
    ].slice(0, LIMITS.neighbourEdges);
    if (dependsOn.length === 0 && dependedOnBy.length === 0) continue;
    const usesSymbols: Record<string, string[]> = {};
    for (const dependency of dependsOn) {
      const symbols = map.edges.find(
        (edge) => edge.from === path && edge.to === dependency,
      )?.symbols;
      if (symbols?.length) usesSymbols[dependency] = symbols;
    }
    result.push({
      path,
      dependsOn,
      dependedOnBy,
      ...(Object.keys(usesSymbols).length > 0 ? { usesSymbols } : {}),
    });
  }
  return result;
}

/**
 * Read the target files' public API as compact signatures (Roadmap N.3), so the
 * agent can see what each file offers without the tool sending its full source.
 * Bounded and best-effort: unreadable or unsupported files are skipped.
 */
async function computeTargetSymbols(
  repositoryRoot: string,
  targetPaths: string[],
  task?: string,
  manifest?: IndexManifest,
): Promise<Array<{ path: string; signatures: string[] }>> {
  const result: Array<{ path: string; signatures: string[] }> = [];
  for (const path of targetPaths.slice(0, LIMITS.symbolFiles)) {
    if (!supportsSymbols(path)) continue;
    try {
      const indexed = manifest?.entries[path]?.symbolTable;
      const table =
        indexed ?? extractSymbolTable(await readFile(join(repositoryRoot, path), "utf8"));
      const signatures = symbolSignatures(table, LIMITS.symbolsPerFile).sort(
        (left, right) => relevanceScore(right, task ?? "") - relevanceScore(left, task ?? ""),
      );
      if (signatures.length > 0) result.push({ path, signatures });
    } catch {
      // Skip files that can't be read; symbols are an enhancement, not required.
    }
  }
  return result;
}

/**
 * Read the current staged and unstaged hunks for target paths. The result is
 * bounded per file so a large change cannot crowd out plan and risk context.
 */
async function readGitDiffs(repositoryRoot: string, paths: string[]): Promise<DiffHunk[]> {
  if (paths.length === 0) return [];
  const sections: string[] = [];
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "HEAD", "--no-ext-diff", "--unified=3", "--", ...paths],
      { cwd: repositoryRoot, maxBuffer: 2_000_000 },
    );
    sections.push(stdout);
  } catch {
    // Repositories without a first commit cannot use `git diff HEAD`. Their
    // staged and unstaged tracked changes are still useful independently.
    for (const args of [
      ["diff", "--cached", "--no-ext-diff", "--unified=3", "--", ...paths],
      ["diff", "--no-ext-diff", "--unified=3", "--", ...paths],
    ]) {
      try {
        const { stdout } = await execFileAsync("git", args, {
          cwd: repositoryRoot,
          maxBuffer: 2_000_000,
        });
        sections.push(stdout);
      } catch {
        // Fall through to untracked-file handling.
      }
    }
  }

  const parsed = parseGitDiff(sections.join("\n"));
  const known = new Set(parsed.map((diff) => diff.path));
  const untracked = await listUntrackedPaths(repositoryRoot, paths);
  for (const path of untracked) {
    if (known.has(path)) continue;
    const patch = await buildUntrackedPatch(repositoryRoot, path);
    if (patch) parsed.push(patch);
  }
  return parsed.slice(0, MAX_DIFF_FILES);
}

function parseGitDiff(diff: string): DiffHunk[] {
  return diff
    .split(/(?=^diff --git )/m)
    .filter((section) => section.startsWith("diff --git "))
    .flatMap((section) => {
      const header = section.match(/^diff --git a\/(.+?) b\/(.+?)\n/m);
      if (!header?.[2]) return [];
      const rawPatch = section.trim();
      const patch = rawPatch.slice(0, MAX_DIFF_CHARS_PER_FILE).trim();
      return patch
        ? [
            {
              path: header[2],
              patch,
              ...(patch.length < rawPatch.length ? { truncated: true } : {}),
            },
          ]
        : [];
    });
}

async function listUntrackedPaths(repositoryRoot: string, paths: string[]): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", ...paths],
      { cwd: repositoryRoot, maxBuffer: 1_000_000 },
    );
    return stdout
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function buildUntrackedPatch(repositoryRoot: string, path: string): Promise<DiffHunk | null> {
  try {
    const content = await readFile(join(repositoryRoot, path), "utf8");
    if (content.includes("\0")) return null;
    const lines = content.split(/\r?\n/);
    const body = lines.map((line) => `+${line}`).join("\n");
    const rawPatch = [
      `diff --git a/${path} b/${path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      body,
    ].join("\n");
    const patch = rawPatch.slice(0, MAX_DIFF_CHARS_PER_FILE).trim();
    return {
      path,
      patch,
      ...(patch.length < rawPatch.length ? { truncated: true } : {}),
    };
  } catch {
    return null;
  }
}

async function rankRelevantFacts(
  facts: FactFile[],
  namespace: string,
  task: string,
  targetPaths: string[],
  semanticRanker?: SemanticRelevanceRanker,
): Promise<RelevantFactSummary[]> {
  const incidentText = new Set(
    facts
      .filter((fact) => fact.category === "incident")
      .map((fact) => normalizeText(fact.content || fact.object)),
  );
  const candidates = facts
    .filter(
      (fact) =>
        fact.namespace === namespace && fact.category !== "incident" && fact.supersededBy === null,
    )
    .map((fact) => {
      const text = `${fact.subject} ${fact.predicate} ${fact.object} ${fact.content}`;
      const taskScore = relevanceScore(text, task);
      // A path match is strong supporting evidence, but must not overwhelm a
      // clearly different task (for example database work near an auth file).
      const pathScore = fact.paths.some((path) => targetPaths.includes(path)) ? 5 : 0;
      const relevance = taskScore + pathScore + Math.round(fact.confidence * 5);
      return {
        fact,
        relevance,
        reason:
          pathScore > 0
            ? "matches a target path"
            : taskScore > 0
              ? `shares ${taskScore} task relevance point(s)`
              : "high-confidence recent project fact",
      };
    });
  let semanticScores: Record<string, number> = {};
  if (semanticRanker && task.trim()) {
    try {
      semanticScores = await semanticRanker(
        task,
        candidates.map(({ fact }) => ({
          id: fact.id,
          text: `${fact.subject} ${fact.predicate} ${fact.object} ${fact.content}`,
        })),
      );
    } catch {
      semanticScores = {};
    }
  }
  return candidates
    .map((candidate) => ({
      ...candidate,
      relevance: candidate.relevance + Math.max(0, semanticScores[candidate.fact.id] ?? 0),
    }))
    .filter(({ fact, relevance }) => {
      if (incidentText.has(normalizeText(fact.content || fact.object))) return false;
      return task.trim() === "" || relevance > Math.round(fact.confidence * 5);
    })
    .sort((left, right) => {
      if (right.relevance !== left.relevance) return right.relevance - left.relevance;
      return right.fact.createdAt.localeCompare(left.fact.createdAt);
    })
    .slice(0, LIMITS.relevantFacts)
    .map(({ fact, relevance, reason }) => ({
      id: fact.id,
      subject: fact.subject,
      summary: truncate(fact.content || fact.object, LIMITS.incidentSummaryChars),
      paths: fact.paths,
      confidence: fact.confidence,
      relevance,
      reason,
    }));
}

function relevanceScore(value: string, task: string): number {
  const terms = new Set(
    normalizeText(task)
      .split(" ")
      .filter((term) => term.length > 2),
  );
  if (terms.size === 0) return 0;
  const haystack = new Set(normalizeText(value).split(" "));
  let score = 0;
  for (const term of terms) if (haystack.has(term)) score += 3;
  return score;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, " ")
    .trim();
}

function classifyPathSource(
  input: BeforeEditInput,
  resolvedCount: number,
  discoveredFromTask: boolean,
): PathSource {
  if (resolvedCount === 0) return "none";
  if (discoveredFromTask) return "task";
  if (input.paths && input.paths.length > 0) return "paths";
  if (input.planId) return "plan";
  return "git";
}

/** Rank cached file summaries for a task when the agent has not named files. */
async function discoverTaskPaths(repositoryRoot: string, task: string): Promise<string[]> {
  const store = new IndexStore(repositoryRoot);
  let manifest = await store.read();
  if (Object.keys(manifest.entries).length === 0) {
    await indexRepository({ repositoryRoot });
    manifest = await store.read();
  }
  const terms = new Set(
    normalizeText(task)
      .split(" ")
      .filter((term) => term.length > 2),
  );
  if (terms.size === 0) return [];
  return Object.values(manifest.entries)
    .map((entry) => {
      const haystack = normalizeText(`${entry.path} ${entry.summary} ${entry.symbols.join(" ")}`);
      const score = [...terms].reduce(
        (total, term) => total + (haystack.includes(term) ? 1 : 0),
        0,
      );
      return { path: entry.path, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, LIMITS.symbolFiles)
    .map((entry) => entry.path);
}

async function loadProjectArchitectureMap(
  repositoryRoot: string,
  manifestPromise: Promise<IndexManifest>,
): Promise<ArchitectureMap> {
  const [config, manifest] = await Promise.all([readConfigFile(repositoryRoot), manifestPromise]);
  if (
    config.graphify?.enabled &&
    (await graphifyGraphExists(repositoryRoot, config.graphify.graphPath))
  ) {
    try {
      return await loadGraphifyMap(
        join(repositoryRoot, config.graphify.graphPath ?? "graphify-out/graph.json"),
        repositoryRoot,
      );
    } catch {
      // An unusable or malformed graph degrades to the built-in import map
      // instead of failing the whole context request.
    }
  }
  return (await loadArchitectureMap(repositoryRoot, manifest)).map;
}

/**
 * Estimate the payload's token footprint and measure it against the cost of
 * reading the represented files' raw source (Phase 04.5). `representedPaths` are
 * the files this context stands in for — target files and import neighbours —
 * which is exactly what an agent would otherwise open and read.
 */
async function buildTokenStats(
  repositoryRoot: string,
  payload: unknown,
  representedPaths: string[],
  tokenBudget: number | undefined,
  manifest?: IndexManifest,
): Promise<TokenStats> {
  const budget = tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const returnedEstimate = estimateTokens(payload ?? {});
  const { stats } = await computeSavings({
    repositoryRoot,
    representedPaths,
    returnedTokens: returnedEstimate,
    budget,
    stages: buildStages(payload),
    ...(manifest ? { manifest } : {}),
  });
  return { budget, returnedEstimate, savings: stats };
}

/** Per-section returned-token breakdown, so callers can see where tokens go. */
function buildStages(payload: unknown): StageStat[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const sections = [
    "plan",
    "policyRules",
    "incidents",
    "facts",
    "risks",
    "neighbours",
    "architecture",
  ];
  const stages: StageStat[] = [];
  for (const stage of sections) {
    if (record[stage] === undefined || record[stage] === null) continue;
    stages.push({ stage, returnedTokens: estimateTokens(record[stage]) });
  }
  return stages;
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
