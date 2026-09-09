import { extname } from "node:path";
import { PlanFileStore, type PlanSpec } from "../core/plan-file-store.js";
import { PlanLifecycle } from "../core/plan-lifecycle.js";
import { buildArchitectureMap } from "../map/indexer.js";
import { assessRisk, resolveRiskPaths } from "../risk/service.js";
import type { Assessment } from "../risk/types.js";
import { generateSuggestions } from "../suggest/engine.js";
import type { SuggestResult } from "../suggest/types.js";
import type { ChangePlanSummary, ChangeReport, ChangeVerification } from "./types.js";

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export type ChangeReportInput = {
  repositoryRoot?: string;
  namespace: string;
  paths?: string[];
  planId?: string;
  useGit?: boolean;
};

/**
 * Compose the signals CodeBuddy already owns into one change-readiness report.
 * This is deliberately read-only: it is safe to run before every commit or in CI.
 */
export async function buildChangeReport(input: ChangeReportInput): Promise<ChangeReport> {
  const repositoryRoot = input.repositoryRoot ?? process.cwd();
  const hasExplicitSelection = (input.paths?.length ?? 0) > 0 || input.planId !== undefined;
  const paths =
    input.useGit === false && !hasExplicitSelection
      ? []
      : await resolveRiskPaths({
          repositoryRoot,
          ...(input.paths !== undefined ? { paths: input.paths } : {}),
          ...(input.planId !== undefined ? { planId: input.planId } : {}),
          ...(input.useGit !== undefined ? { useGit: input.useGit } : { useGit: true }),
        });

  const planStore = new PlanFileStore(repositoryRoot);
  const [risk, suggestions, plan, map] = await Promise.all([
    paths.length === 0
      ? Promise.resolve(emptyAssessment())
      : assessRisk({
          repositoryRoot,
          namespace: input.namespace,
          paths,
          ...(input.planId !== undefined ? { planId: input.planId } : {}),
        }),
    paths.length === 0
      ? Promise.resolve(emptySuggestions())
      : generateSuggestions({ repositoryRoot, namespace: input.namespace, paths }),
    resolveRelevantPlan(planStore, input.namespace, input.planId),
    buildArchitectureMap(repositoryRoot),
  ]);

  const planSummary = summarizePlan(plan, paths);
  const verification = buildVerification(paths, planSummary, suggestions);
  const dependentsByPath = countDependents(map.edges, paths);
  const highestScore = risk.items.reduce((highest, item) => Math.max(highest, item.score), 0);
  const status = getStatus(paths, highestScore, suggestions, verification);

  return {
    status,
    paths,
    plan: planSummary,
    risk: { highestScore, items: risk.items },
    architecture: {
      dependentsByPath,
      totalDependents: Object.values(dependentsByPath).reduce((sum, count) => sum + count, 0),
    },
    suggestions: suggestions.suggestions,
    verification,
  };
}

function emptyAssessment(): Assessment {
  return {
    items: [],
    stats: { pathsConsidered: 0, itemsProduced: 0, signalsRun: 0, perSignal: [] },
  };
}

function emptySuggestions(): SuggestResult {
  return {
    suggestions: [],
    stats: { pathsConsidered: 0, produced: 0, byCategory: {}, bySeverity: {} },
  };
}

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

function summarizePlan(plan: PlanSpec | null, paths: string[]): ChangePlanSummary | null {
  if (!plan) return null;
  const plannedPaths = plan.filesToTouch.map((file) => file.path).sort();
  const plannedSet = new Set(plannedPaths);
  const unexpectedPaths = paths.filter((path) => !plannedSet.has(path));
  const plannedTests = plan.testsToAdd.map((test) => test.path).sort();
  const changed = new Set(paths);
  const missingPlannedTests = plannedTests.filter((path) => !changed.has(path));
  return {
    id: plan.id,
    title: plan.title,
    status: plan.status,
    plannedPaths,
    unexpectedPaths,
    plannedTests,
    missingPlannedTests,
  };
}

function buildVerification(
  paths: string[],
  plan: ChangePlanSummary | null,
  suggestions: { suggestions: ChangeReport["suggestions"] },
): ChangeVerification {
  const changedTestFiles = paths.filter(isTestFile);
  const changedCodeFiles = paths.filter((path) => isCodeFile(path) && !isTestFile(path));
  const uncovered = new Set(
    suggestions.suggestions
      .filter((suggestion) => suggestion.category === "missing_test" && suggestion.path)
      .map((suggestion) => suggestion.path as string),
  );
  const plannedTests = plan?.plannedTests ?? [];
  const missingPlannedTests = plan?.missingPlannedTests ?? [];
  return {
    changedCodeFiles,
    changedTestFiles,
    uncoveredCodeFiles: changedCodeFiles.filter((path) => uncovered.has(path)),
    plannedTests,
    missingPlannedTests,
    readyToVerify: changedTestFiles.length > 0 || changedCodeFiles.length === 0,
  };
}

function countDependents(
  edges: Array<{ from: string; to: string }>,
  paths: string[],
): Record<string, number> {
  const targets = new Set(paths);
  const counts: Record<string, number> = {};
  for (const path of paths) counts[path] = 0;
  for (const edge of edges) {
    if (targets.has(edge.to)) counts[edge.to] = (counts[edge.to] ?? 0) + 1;
  }
  return counts;
}

function getStatus(
  paths: string[],
  highestRisk: number,
  suggestions: { suggestions: ChangeReport["suggestions"] },
  verification: ChangeVerification,
): ChangeReport["status"] {
  if (paths.length === 0) return "no_changes";
  if (highestRisk >= 75 || suggestions.suggestions.some((item) => item.severity === "high")) {
    return "blocked";
  }
  if (
    highestRisk >= 50 ||
    suggestions.suggestions.some((item) => item.severity === "medium") ||
    verification.uncoveredCodeFiles.length > 0 ||
    verification.missingPlannedTests.length > 0
  ) {
    return "review";
  }
  return "ready";
}

function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase());
}

function isTestFile(path: string): boolean {
  return /(^|\/)(__tests__\/|.*\.(test|spec)\.)/.test(path);
}
