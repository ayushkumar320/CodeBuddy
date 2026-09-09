import type { Command } from "commander";
import pc from "picocolors";
import { buildChangeReport } from "../../change/engine.js";
import type { ChangeReport, ChangeStatus } from "../../change/types.js";
import { resolveNamespaceFrom } from "../../core/config-file.js";

export function registerChangeCommand(
  program: Command,
  runSafely: (fn: () => Promise<void>) => Promise<void>,
): void {
  program
    .command("change")
    .option("--paths <paths>", "Comma-separated repo-relative paths to review.")
    .option("--plan <id>", "Review the files listed in a plan.")
    .option("--no-git", "Do not include the current Git change set.")
    .option("--json", "Print machine-readable JSON.")
    .description("Report whether the current change is ready, needs review, or is blocked.")
    .action(async (opts: { paths?: string; plan?: string; git?: boolean; json?: boolean }) => {
      await runSafely(async () => {
        const report = await buildChangeReport({
          namespace: await resolveNamespaceFrom(),
          ...(opts.paths ? { paths: parsePaths(opts.paths) } : {}),
          ...(opts.plan ? { planId: opts.plan } : {}),
          ...(opts.git !== undefined ? { useGit: opts.git } : {}),
        });
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        printReport(report);
      });
    });
}

function parsePaths(value: string): string[] {
  return value
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean);
}

function printReport(report: ChangeReport): void {
  console.log(`${statusBadge(report.status)} ${pc.bold("change report")}`);
  if (report.paths.length === 0) {
    console.log(pc.dim("  no changed paths detected"));
    return;
  }
  console.log(`  ${report.paths.length} path(s): ${report.paths.join(", ")}`);
  console.log(`  highest risk: ${report.risk.highestScore}`);
  console.log(
    `  architecture: ${report.architecture.totalDependents} direct dependent edge(s) across the change set`,
  );
  if (report.plan) {
    console.log(`  plan: ${report.plan.id} ${report.plan.title} (${report.plan.status})`);
    if (report.plan.unexpectedPaths.length > 0)
      console.log(`  plan drift: ${report.plan.unexpectedPaths.join(", ")}`);
    if (report.plan.missingPlannedTests.length > 0)
      console.log(`  planned tests still missing: ${report.plan.missingPlannedTests.join(", ")}`);
  } else {
    console.log(pc.dim("  plan: no active plan"));
  }
  console.log(
    `  verification: ${report.verification.changedTestFiles.length} test file(s) changed; ${report.verification.uncoveredCodeFiles.length} code file(s) without a discovered test`,
  );
  if (report.suggestions.length > 0) {
    console.log("\n  findings:");
    for (const suggestion of report.suggestions.slice(0, 8)) {
      console.log(`  ${severityBadge(suggestion.severity)} ${suggestion.title}`);
      console.log(pc.dim(`    ${suggestion.detail}`));
    }
  } else {
    console.log(pc.dim("\n  findings: none"));
  }
}

function statusBadge(status: ChangeStatus): string {
  if (status === "blocked") return pc.red("[blocked]");
  if (status === "review") return pc.yellow("[review ]");
  if (status === "ready") return pc.green("[ready  ]");
  return pc.dim("[no diff ]");
}

function severityBadge(severity: string): string {
  if (severity === "high") return pc.red("[high]");
  if (severity === "medium") return pc.yellow("[med ]");
  return pc.dim(`[${severity.padEnd(5)}]`);
}
