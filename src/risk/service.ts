import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { MemoryFileStore } from "../core/memory-file-store.js";
import { PlanFileStore } from "../core/plan-file-store.js";
import { RiskAssessor } from "./assessor.js";
import { createChurnSignal } from "./signals/churn.js";
import { createIncidentSignal } from "./signals/incident.js";
import { createPolicySignal } from "./signals/policy.js";
import type { Assessment, Signal } from "./types.js";

export type RiskAssessRequest = {
  repositoryRoot?: string;
  namespace: string;
  paths?: string[];
  planId?: string;
  useGit?: boolean;
  limit?: number;
  signals?: Signal[];
};

export async function assessRisk(input: RiskAssessRequest): Promise<Assessment> {
  const repositoryRoot = resolve(input.repositoryRoot ?? process.cwd());
  const paths = await resolveRiskPaths({
    repositoryRoot,
    ...(input.planId !== undefined ? { planId: input.planId } : {}),
    ...(input.paths !== undefined ? { paths: input.paths } : {}),
    ...(input.useGit !== undefined ? { useGit: input.useGit } : {}),
  });
  if (paths.length === 0) {
    return {
      items: [],
      stats: { pathsConsidered: 0, itemsProduced: 0, signalsRun: 0, perSignal: [] },
    };
  }

  const memoryStore = new MemoryFileStore(repositoryRoot);
  const signals = input.signals ?? [
    createIncidentSignal({ store: memoryStore }),
    createPolicySignal({ repositoryRoot }),
    createChurnSignal({ repositoryRoot }),
  ];

  const assessment = await new RiskAssessor(signals).assess({
    paths,
    repositoryRoot,
    namespace: input.namespace,
  });
  return {
    ...assessment,
    items: input.limit ? assessment.items.slice(0, input.limit) : assessment.items,
  };
}

export async function resolveRiskPaths(input: {
  repositoryRoot: string;
  paths?: string[];
  planId?: string;
  useGit?: boolean;
}): Promise<string[]> {
  const paths = new Set<string>();
  for (const path of input.paths ?? []) {
    if (path.trim()) paths.add(normalizePath(path));
  }

  if (input.planId) {
    const plan = await new PlanFileStore(input.repositoryRoot).readPlan(input.planId);
    for (const file of plan.filesToTouch) paths.add(normalizePath(file.path));
  }

  if (input.useGit || paths.size === 0) {
    for (const path of await changedGitPaths(input.repositoryRoot)) paths.add(normalizePath(path));
  }

  return [...paths].sort();
}

async function changedGitPaths(repositoryRoot: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    runGit(repositoryRoot, ["diff", "--name-only", "HEAD"]),
    runGit(repositoryRoot, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  return [...tracked.stdout.split("\n"), ...untracked.stdout.split("\n")]
    .map((path) => path.trim())
    .filter(Boolean);
}

function runGit(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code: code ?? 0, stdout, stderr }));
  });
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}
