import type { Command } from "commander";
import pc from "picocolors";
import { resolveNamespaceFrom } from "../../core/config-file.js";
import { assessRisk } from "../../risk/service.js";
import type { Assessment, Evidence } from "../../risk/types.js";

export function registerRiskCommands(
  program: Command,
  runSafely: (fn: () => Promise<void>) => Promise<void>,
): void {
  const risk = program.command("risk").description("Assess evidence-backed change risk.");

  risk
    .command("assess")
    .option("--plan <id>", "Assess paths listed in a CodeBuddy plan.")
    .option("--paths <paths>", "Comma-separated repo-relative paths to assess.")
    .option("--git", "Assess staged, unstaged, and untracked git changes.")
    .option("--limit <n>", "Maximum risk items to show.", Number)
    .option("--json", "Print machine-readable JSON.")
    .option("--explain", "Show evidence for each risk item.")
    .description("Assess risk for a plan, explicit paths, or current git changes.")
    .action(
      async (opts: {
        plan?: string;
        paths?: string;
        git?: boolean;
        limit?: number;
        json?: boolean;
        explain?: boolean;
      }) => {
        await runSafely(async () => {
          const namespace = await resolveNamespaceFrom();
          const assessment = await assessRisk({
            namespace,
            ...(opts.plan ? { planId: opts.plan } : {}),
            ...(opts.paths ? { paths: parsePaths(opts.paths) } : {}),
            ...(opts.git !== undefined ? { useGit: opts.git } : {}),
            ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
          });
          if (opts.json) {
            console.log(JSON.stringify(assessment, null, 2));
            return;
          }
          printAssessment(assessment, opts.explain ?? false);
        });
      },
    );
}

function parsePaths(value: string): string[] {
  return value
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean);
}

function printAssessment(assessment: Assessment, explain: boolean): void {
  if (assessment.items.length === 0) {
    console.log(pc.dim("no risk evidence found"));
    return;
  }
  for (const item of assessment.items) {
    console.log(
      `${pc.bold(item.path)}  score ${scoreColor(item.score)}  category ${pc.cyan(item.category)}`,
    );
    console.log(`  ${item.reason}`);
    if (explain) {
      for (const evidence of item.evidence) console.log(`  ↳ ${formatEvidence(evidence)}`);
    } else {
      console.log(pc.dim(`  ${item.evidence.length} evidence item(s)`));
    }
  }
  console.log(
    pc.dim(
      `\n${assessment.stats.itemsProduced} item(s), ${assessment.stats.signalsRun} signal(s), ${assessment.stats.pathsConsidered} path(s) considered`,
    ),
  );
}

function scoreColor(score: number): string {
  if (score >= 75) return pc.red(String(score));
  if (score >= 50) return pc.yellow(String(score));
  return pc.green(String(score));
}

function formatEvidence(evidence: Evidence): string {
  switch (evidence.kind) {
    case "memory_fact":
      return `memory ${evidence.factId}: ${truncate(evidence.content, 90)}`;
    case "git_commit":
      return `commit ${evidence.sha.slice(0, 7)} ${evidence.ts}: ${evidence.message}`;
    case "policy_rule":
      return `policy ${evidence.ruleId}: ${evidence.pattern}`;
    case "dependent_module":
      return `dependent ${evidence.path} depth=${evidence.depth}`;
    case "ci_failure":
      return `ci ${evidence.runId} ${evidence.conclusion} ${evidence.ts}`;
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
