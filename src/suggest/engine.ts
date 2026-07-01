import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { MemoryFileStore } from "../core/memory-file-store.js";
import { PlanFileStore, type PlanSpec } from "../core/plan-file-store.js";
import { PlanLifecycle } from "../core/plan-lifecycle.js";
import { buildArchitectureMap } from "../map/indexer.js";
import type { ArchitectureMap } from "../map/types.js";
import { assessRisk, resolveRiskPaths } from "../risk/service.js";
import { readPolicyFile } from "../risk/signals/policy.js";
import { SEVERITY_RANK, type Suggestion, type SuggestResult } from "./types.js";

/**
 * Deterministic, read-only suggestion generation. Nothing here writes to disk
 * or edits code — it only reads the working tree and CodeBuddy's own artifacts.
 * Each category attaches its own evidence; anything without evidence is not
 * emitted. Findings are de-duplicated per (category, path) and ranked by
 * severity so the few important ones surface first.
 */

const RISK_SUGGEST_THRESHOLD = 50;
const BLAST_RADIUS_MEDIUM = 5;
const BLAST_RADIUS_HIGH = 10;
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export type SuggestInput = {
  repositoryRoot?: string;
  namespace: string;
  paths?: string[];
  planId?: string;
  useGit?: boolean;
  limit?: number;
};

export async function generateSuggestions(input: SuggestInput): Promise<SuggestResult> {
  const repositoryRoot = resolve(input.repositoryRoot ?? process.cwd());
  const namespace = input.namespace;

  const targetPaths = await resolveRiskPaths({
    repositoryRoot,
    ...(input.paths !== undefined ? { paths: input.paths } : {}),
    ...(input.planId !== undefined ? { planId: input.planId } : {}),
    ...(input.useGit !== undefined ? { useGit: input.useGit } : {}),
  });

  const planStore = new PlanFileStore(repositoryRoot);
  const memoryStore = new MemoryFileStore(repositoryRoot);

  const [risks, plan, incidents, map, policyFile] = await Promise.all([
    assessRisk({
      repositoryRoot,
      namespace,
      ...(input.paths !== undefined ? { paths: input.paths } : {}),
      ...(input.planId !== undefined ? { planId: input.planId } : {}),
      ...(input.useGit !== undefined ? { useGit: input.useGit } : {}),
    }),
    resolveRelevantPlan(planStore, namespace, input.planId),
    memoryStore.findIncidentFactsForPaths({ namespace, paths: targetPaths }),
    buildArchitectureMap(repositoryRoot),
    readPolicyFile(join(repositoryRoot, ".codebuddy", "policies.yaml")),
  ]);

  const suggestions: Suggestion[] = [];

  // 1. Risk — surface the change set's highest-scoring paths.
  for (const item of risks.items) {
    if (item.score < RISK_SUGGEST_THRESHOLD) continue;
    suggestions.push({
      id: `risk:${item.path}`,
      category: "risk",
      severity: item.score >= 75 ? "high" : "medium",
      title: `Review high-risk change to ${item.path}`,
      detail: item.reason,
      path: item.path,
      evidence: [
        { kind: "risk_score", detail: `score ${item.score} (${item.category})` },
        ...(item.evidence.length > 0
          ? [{ kind: "risk_evidence", detail: `${item.evidence.length} evidence item(s)` }]
          : []),
      ],
      commandHint: `codebuddy risk assess --paths ${item.path} --explain`,
    });
  }

  // 2. Incident history — files with an unresolved past incident.
  for (const incident of incidents) {
    const path = incident.paths[0] ?? "(unknown)";
    suggestions.push({
      id: `incident:${path}`,
      category: "incident",
      severity: "high",
      title: `Recurring incident hotspot: ${path}`,
      detail: `${incident.subject} — proceed carefully; this area has an unresolved incident.`,
      path,
      evidence: [{ kind: "incident", detail: `${incident.id} severity=${incident.severity}` }],
    });
  }

  // 3. Architecture — high blast radius (many dependents).
  const inbound = inboundDegrees(map);
  for (const path of targetPaths) {
    const dependents = inbound.get(path) ?? 0;
    if (dependents < BLAST_RADIUS_MEDIUM) continue;
    suggestions.push({
      id: `architecture:${path}`,
      category: "architecture",
      severity: dependents >= BLAST_RADIUS_HIGH ? "high" : "medium",
      title: `High blast radius: ${path}`,
      detail: `${dependents} module(s) import ${path}; a change here ripples widely.`,
      path,
      evidence: [{ kind: "dependents", detail: `${dependents} inbound import(s)` }],
      commandHint: `codebuddy map dependents ${path}`,
    });
  }

  // 4. Plan divergence — editing files the active plan does not cover.
  if (plan) {
    const planned = new Set(plan.filesToTouch.map((file) => normalize(file.path)));
    const strays = targetPaths.filter((path) => !planned.has(normalize(path)));
    if (planned.size > 0 && strays.length > 0) {
      suggestions.push({
        id: `plan_divergence:${plan.id}`,
        category: "plan_divergence",
        severity: "medium",
        title: `Change set diverges from plan ${plan.id}`,
        detail: `${strays.length} target file(s) are outside the active plan's scope: ${strays
          .slice(0, 5)
          .join(", ")}.`,
        evidence: [
          { kind: "plan", detail: `plan ${plan.id} (${plan.status})` },
          { kind: "out_of_scope", detail: strays.slice(0, 5).join(", ") },
        ],
        commandHint: `codebuddy plan show ${plan.id}`,
      });
    }
  }

  // 5. Missing tests — changed code files with no discoverable test.
  for (const path of targetPaths) {
    if (!isTestableCode(path)) continue;
    if (await hasSiblingTest(repositoryRoot, path)) continue;
    suggestions.push({
      id: `missing_test:${path}`,
      category: "missing_test",
      severity: "low",
      title: `No test found for ${path}`,
      detail: "Consider adding a test alongside this change.",
      path,
      evidence: [{ kind: "no_test", detail: "no *.test.* / *.spec.* sibling found" }],
    });
  }

  // 6. Stale policy — a rule whose target directory no longer exists.
  for (const rule of policyFile.rules) {
    const prefix = literalPrefix(rule.pattern);
    if (!prefix) continue;
    if (await pathExists(join(repositoryRoot, prefix))) continue;
    suggestions.push({
      id: `stale_policy:${rule.id}`,
      category: "stale_policy",
      severity: "low",
      title: `Stale policy rule "${rule.id}"`,
      detail: `Pattern "${rule.pattern}" targets "${prefix}", which does not exist.`,
      evidence: [{ kind: "policy_rule", detail: `${rule.id} → ${rule.pattern}` }],
    });
  }

  const deduped = dedupe(suggestions).sort(compareSuggestions);
  const limited = input.limit ? deduped.slice(0, input.limit) : deduped;

  return {
    suggestions: limited,
    stats: buildStats(targetPaths.length, limited),
  };
}

// ── helpers ─────────────────────────────────────────────────────────

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

function inboundDegrees(map: ArchitectureMap): Map<string, number> {
  const inbound = new Map<string, number>();
  for (const edge of map.edges) inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
  return inbound;
}

function isTestableCode(path: string): boolean {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return false;
  if (path.endsWith(".d.ts")) return false;
  if (path.includes("__tests__/")) return false;
  return CODE_EXTENSIONS.has(extname(path).toLowerCase());
}

async function hasSiblingTest(repositoryRoot: string, path: string): Promise<boolean> {
  const ext = extname(path);
  const base = path.slice(0, path.length - ext.length);
  const dir = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
  const name = base.includes("/") ? base.slice(base.lastIndexOf("/") + 1) : base;
  const candidates = [
    `${base}.test${ext}`,
    `${base}.spec${ext}`,
    `${dir ? `${dir}/` : ""}__tests__/${name}${ext}`,
    `${dir ? `${dir}/` : ""}__tests__/${name}.test${ext}`,
  ];
  for (const candidate of candidates) {
    if (await pathExists(join(repositoryRoot, candidate))) return true;
  }
  return false;
}

/**
 * The literal directory prefix of a glob — everything before the first
 * wildcard, trimmed to a whole path segment. `src/auth/**` → `src/auth`,
 * `src/**​/*.ts` → `src`, `*.env` → `` (no literal prefix to check).
 */
function literalPrefix(pattern: string): string {
  const normalized = normalize(pattern);
  const wildcard = normalized.search(/[*?[]/);
  if (wildcard === -1) return normalized.replace(/\/+$/, "");
  const beforeWildcard = normalized.slice(0, wildcard);
  const lastSlash = beforeWildcard.lastIndexOf("/");
  return lastSlash === -1 ? "" : beforeWildcard.slice(0, lastSlash);
}

function dedupe(suggestions: Suggestion[]): Suggestion[] {
  const byId = new Map<string, Suggestion>();
  for (const suggestion of suggestions) {
    const existing = byId.get(suggestion.id);
    if (!existing || SEVERITY_RANK[suggestion.severity] > SEVERITY_RANK[existing.severity]) {
      byId.set(suggestion.id, suggestion);
    }
  }
  return [...byId.values()];
}

function compareSuggestions(left: Suggestion, right: Suggestion): number {
  const severity = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
  if (severity !== 0) return severity;
  if (left.category !== right.category) return left.category.localeCompare(right.category);
  return (left.path ?? "").localeCompare(right.path ?? "");
}

function buildStats(pathsConsidered: number, suggestions: Suggestion[]) {
  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const suggestion of suggestions) {
    byCategory[suggestion.category] = (byCategory[suggestion.category] ?? 0) + 1;
    bySeverity[suggestion.severity] = (bySeverity[suggestion.severity] ?? 0) + 1;
  }
  return { pathsConsidered, produced: suggestions.length, byCategory, bySeverity };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}
