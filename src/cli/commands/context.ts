import { basename } from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { buildBeforeEditContext, buildBootstrapContext } from "../../context/engine.js";
import type { BeforeEditContext, BootstrapContext } from "../../context/types.js";
import { readConfigFile } from "../../core/config-file.js";

/**
 * Context previews are file-based (plan store, risk service, architecture map,
 * Markdown memory) so they run without a database connection — the same
 * lightweight path the plan and risk commands use.
 */
async function resolveNamespace(cwd = process.cwd()): Promise<string> {
  if (process.env.CODEBUDDY_NAMESPACE) return process.env.CODEBUDDY_NAMESPACE;
  const file = await readConfigFile(cwd);
  return file.namespace ?? basename(cwd);
}

async function resolveTokenBudget(cwd = process.cwd()): Promise<number | undefined> {
  const file = await readConfigFile(cwd);
  return file.tokenBudget;
}

function parsePaths(value: string): string[] {
  return value
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean);
}

export function registerContextCommands(
  program: Command,
  runSafely: (fn: () => Promise<void>) => Promise<void>,
): void {
  const context = program
    .command("context")
    .description("Preview the compact project context CodeBuddy would send to an agent.");

  context
    .command("bootstrap")
    .option("--json", "Print machine-readable JSON.")
    .description("Show start-of-turn project awareness (plan, policy, incidents, architecture).")
    .action(async (opts: { json?: boolean }) => {
      await runSafely(async () => {
        const [namespace, tokenBudget] = await Promise.all([
          resolveNamespace(),
          resolveTokenBudget(),
        ]);
        const result = await buildBootstrapContext({
          namespace,
          ...(tokenBudget !== undefined ? { tokenBudget } : {}),
        });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        printBootstrap(result);
      });
    });

  context
    .command("preview")
    .argument("[task...]", "The task you are about to work on.")
    .option("--paths <paths>", "Comma-separated repo-relative paths to target.")
    .option("--plan <id>", "Resolve target files from a CodeBuddy plan.")
    .option("--git", "Resolve target files from current git changes.")
    .option("--json", "Print machine-readable JSON.")
    .description("Show the context CodeBuddy would assemble before editing the given files.")
    .action(
      async (
        taskParts: string[],
        opts: { paths?: string; plan?: string; git?: boolean; json?: boolean },
      ) => {
        await runSafely(async () => {
          const result = await runBeforeEdit(taskParts, opts);
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          printBeforeEdit(result);
        });
      },
    );

  context
    .command("explain")
    .argument("[task...]", "The task you are about to work on.")
    .option("--paths <paths>", "Comma-separated repo-relative paths to target.")
    .option("--plan <id>", "Resolve target files from a CodeBuddy plan.")
    .option("--git", "Resolve target files from current git changes.")
    .description("Explain why each piece of before-edit context was included.")
    .action(async (taskParts: string[], opts: { paths?: string; plan?: string; git?: boolean }) => {
      await runSafely(async () => {
        const result = await runBeforeEdit(taskParts, opts);
        console.log(pc.bold(`context for ${result.targetPaths.length} target path(s):`));
        for (const line of result.explain) console.log(`  ${pc.dim("•")} ${line}`);
        const savings = result.tokens.savings;
        if (savings.available) {
          const percent = Math.round((1 - savings.compressionRatio) * 100);
          console.log(pc.bold("\nsavings:"));
          console.log(
            `  ${pc.green(`${savings.savedTokens} tokens saved`)} ${pc.dim(`(${percent}% vs reading ${savings.representedFiles} raw file(s): ${savings.baselineTokens} → ${savings.returnedTokens})`)}`,
          );
          for (const stage of savings.stages) {
            console.log(`  ${pc.dim("•")} ${stage.stage}: ${stage.returnedTokens} tokens`);
          }
        }
      });
    });
}

async function runBeforeEdit(
  taskParts: string[],
  opts: { paths?: string; plan?: string; git?: boolean },
): Promise<BeforeEditContext> {
  const [namespace, tokenBudget] = await Promise.all([resolveNamespace(), resolveTokenBudget()]);
  const task = taskParts.join(" ").trim();
  return buildBeforeEditContext({
    namespace,
    ...(task ? { task } : {}),
    ...(opts.paths ? { paths: parsePaths(opts.paths) } : {}),
    ...(opts.plan ? { planId: opts.plan } : {}),
    ...(opts.git !== undefined ? { useGit: opts.git } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
  });
}

function printBootstrap(ctx: BootstrapContext): void {
  console.log(`${pc.bold("project")} ${ctx.project.namespace}  ${pc.dim(ctx.project.root)}`);
  console.log(
    `${pc.bold("plan")} ${ctx.plan ? `${ctx.plan.title} (${ctx.plan.status})` : pc.dim("none")}  ${pc.dim(`policy=${ctx.policy}`)}`,
  );
  if (ctx.policyRules.length > 0) {
    console.log(pc.bold("policy rules:"));
    for (const rule of ctx.policyRules) {
      console.log(`  ${rule.id} (${rule.weight}) ${pc.dim(rule.pattern)}`);
    }
  }
  if (ctx.incidents.length > 0) {
    console.log(pc.bold("incident hotspots:"));
    for (const incident of ctx.incidents) {
      console.log(
        `  ${severityColor(incident.severity)} ${incident.subject} ${pc.dim(incident.summary)}`,
      );
    }
  }
  console.log(
    `${pc.bold("architecture")} ${ctx.architecture.moduleCount} modules, ${ctx.architecture.edgeCount} edges`,
  );
  for (const hotspot of ctx.architecture.hotspots) {
    console.log(`  ${hotspot.path} ${pc.dim(`in=${hotspot.inbound} out=${hotspot.outbound}`)}`);
  }
  printTokens(ctx);
}

function printBeforeEdit(ctx: BeforeEditContext): void {
  console.log(
    `${pc.bold("targets")} ${ctx.targetPaths.length} path(s) ${pc.dim(`(source: ${ctx.pathSource})`)}`,
  );
  for (const path of ctx.targetPaths) console.log(`  ${path}`);
  if (ctx.plan) console.log(`${pc.bold("plan")} ${ctx.plan.title} (${ctx.plan.status})`);
  if (ctx.policyRules.length > 0) {
    console.log(pc.bold("matching policy rules:"));
    for (const rule of ctx.policyRules) console.log(`  ${rule.id} ${pc.dim(rule.pattern)}`);
  }
  if (ctx.incidents.length > 0) {
    console.log(pc.bold("incidents on target paths:"));
    for (const incident of ctx.incidents) {
      console.log(`  ${severityColor(incident.severity)} ${incident.subject}`);
    }
  }
  if (ctx.risks.items.length > 0) {
    console.log(pc.bold("risk:"));
    for (const item of ctx.risks.items) {
      console.log(`  ${item.path} ${scoreColor(item.score)} ${pc.dim(item.reason)}`);
    }
  }
  if (ctx.neighbours.length > 0) {
    console.log(pc.bold("import neighbours:"));
    for (const neighbour of ctx.neighbours) {
      console.log(
        `  ${neighbour.path} ${pc.dim(`→${neighbour.dependsOn.length} ←${neighbour.dependedOnBy.length}`)}`,
      );
    }
  }
  printTokens(ctx);
}

function printTokens(ctx: BootstrapContext | BeforeEditContext): void {
  const { returnedEstimate, budget, savings } = ctx.tokens;
  let line = `\n~${returnedEstimate} tokens returned (budget ${budget})`;
  if (savings.available) {
    const percent = Math.round((1 - savings.compressionRatio) * 100);
    line += `; saved ~${savings.savedTokens} vs raw source (${percent}% smaller)`;
  }
  console.log(pc.dim(line));
}

function severityColor(severity: string): string {
  if (severity === "critical") return pc.red(severity);
  if (severity === "high") return pc.red(severity);
  if (severity === "medium") return pc.yellow(severity);
  return pc.dim(severity);
}

function scoreColor(score: number): string {
  if (score >= 75) return pc.red(String(score));
  if (score >= 50) return pc.yellow(String(score));
  return pc.green(String(score));
}
