import type { Command } from "commander";
import pc from "picocolors";
import { buildChangeReport, verifyChange } from "../../change/engine.js";
import type { ChangeReport, ChangeStatus, ChangeVerificationResult } from "../../change/types.js";
import { resolveNamespaceFrom } from "../../core/config-file.js";

export function registerChangeCommand(
  program: Command,
  runSafely: (fn: () => Promise<void>) => Promise<void>,
): void {
  const change = program.command("change").description("Assess and verify the current change.");

  change
    .command("report", { isDefault: true })
    .description("Report whether the current change is ready, needs review, or is blocked.")
    .option("--paths <paths>", "Comma-separated repo-relative paths to review.")
    .option("--plan <id>", "Review the files listed in a plan.")
    .option("--no-git", "Do not include the current Git change set.")
    .option("--graphify <path>", "Use a Graphify graph.json for deeper architecture edges.")
    .option("--json", "Print machine-readable JSON.")
    .action(async (opts: ChangeOptions) => {
      await runSafely(async () => {
        const report = await buildChangeReport(toInput(opts, await resolveNamespaceFrom()));
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        printReport(report);
      });
    });

  change
    .command("verify")
    .description("Run the detected test command and report whether the change is verified.")
    .option("--paths <paths>", "Comma-separated repo-relative paths to review.")
    .option("--plan <id>", "Review the files listed in a plan.")
    .option("--no-git", "Do not include the current Git change set.")
    .option("--graphify <path>", "Use a Graphify graph.json for deeper architecture edges.")
    .option("--command <command>", "Override the detected test command.")
    .option("--timeout <ms>", "Stop the test command after this many milliseconds.", Number)
    .option("--json", "Print machine-readable JSON.")
    .action(async (opts: VerifyOptions) => {
      await runSafely(async () => {
        const result = await verifyChange({
          ...toInput(opts, await resolveNamespaceFrom()),
          ...(opts.command ? { command: opts.command } : {}),
          ...(opts.timeout !== undefined ? { timeoutMs: opts.timeout } : {}),
        });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          printVerification(result);
        }
        if (result.test.status !== "passed") process.exitCode = 1;
      });
    });
}

type ChangeOptions = {
  paths?: string;
  plan?: string;
  git?: boolean;
  json?: boolean;
  graphify?: string;
};

type VerifyOptions = ChangeOptions & {
  command?: string;
  timeout?: number;
};

function toInput(opts: ChangeOptions, namespace: string) {
  return {
    namespace,
    ...(opts.paths ? { paths: parsePaths(opts.paths) } : {}),
    ...(opts.plan ? { planId: opts.plan } : {}),
    ...(opts.git !== undefined ? { useGit: opts.git } : {}),
    ...(opts.graphify ? { graphifyPath: opts.graphify } : {}),
  };
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
    `  architecture: ${report.architecture.totalDependents} direct dependent edge(s) across the change set (${report.architecture.source})`,
  );
  if (report.architecture.warning) console.log(pc.yellow(`  ${report.architecture.warning}`));
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

function printVerification(result: ChangeVerificationResult): void {
  printReport(result.report);
  console.log(`\n${testBadge(result.test.status)} verification`);
  console.log(`  command: ${result.test.command ?? "none detected"}`);
  if (result.test.durationMs > 0) console.log(`  duration: ${result.test.durationMs}ms`);
  if (result.test.output) {
    console.log("  output:");
    for (const line of result.test.output.split("\n")) console.log(`    ${line}`);
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

function testBadge(status: ChangeVerificationResult["test"]["status"]): string {
  if (status === "passed") return pc.green("[passed ]");
  if (status === "timed_out") return pc.red("[timeout]");
  if (status === "failed") return pc.red("[failed ]");
  return pc.yellow("[not run]");
}
