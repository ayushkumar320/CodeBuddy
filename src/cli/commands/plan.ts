import { spawn } from "node:child_process";
import { relative } from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import {
  loadPlanPolicy,
  PLAN_POLICIES,
  type PlanPolicy,
  resolveNamespaceFrom,
  setPlanPolicy,
} from "../../core/config-file.js";
import { PlanFileStore, type PlanSpec, type PlanStatus } from "../../core/plan-file-store.js";
import { PlanLifecycle } from "../../core/plan-lifecycle.js";

/**
 * Resolve the active namespace for plan commands without requiring a
 * database connection — plans are file-based, so a developer can author
 * and inspect them with no Postgres running.
 */

function makeLifecycle(cwd = process.cwd()): { store: PlanFileStore; lifecycle: PlanLifecycle } {
  const store = new PlanFileStore(cwd);
  return { store, lifecycle: new PlanLifecycle(store) };
}

function statusColor(status: PlanStatus): string {
  switch (status) {
    case "draft":
      return pc.dim(status);
    case "approved":
      return pc.cyan(status);
    case "executing":
      return pc.yellow(status);
    case "complete":
      return pc.green(status);
    case "abandoned":
      return pc.red(status);
  }
}

function renderPlan(plan: PlanSpec): string {
  const lines: string[] = [];
  lines.push(`${pc.bold(plan.title)}  ${statusColor(plan.status)}`);
  lines.push(pc.dim(plan.id));
  lines.push("");
  lines.push(`${pc.bold("Brief:")} ${plan.brief}`);
  if (plan.filesToTouch.length > 0) {
    lines.push("");
    lines.push(pc.bold("Files to touch:"));
    for (const file of plan.filesToTouch) {
      lines.push(`  ${file.action.padEnd(6)} ${file.path}${file.notes ? `  — ${file.notes}` : ""}`);
    }
  }
  if (plan.testsToAdd.length > 0) {
    lines.push("");
    lines.push(pc.bold("Tests to add:"));
    for (const test of plan.testsToAdd) {
      lines.push(`  ${test.path}${test.description ? `  — ${test.description}` : ""}`);
    }
  }
  if (plan.outOfScope.length > 0) {
    lines.push("");
    lines.push(pc.bold("Out of scope:"));
    for (const item of plan.outOfScope) lines.push(`  - ${item}`);
  }
  if (plan.risks.length > 0) {
    lines.push("");
    lines.push(pc.bold("Risks:"));
    for (const item of plan.risks) lines.push(`  - ${item}`);
  }
  if (plan.commitSha) {
    lines.push("");
    lines.push(`${pc.bold("Commit:")} ${plan.commitSha}`);
  }
  lines.push("");
  lines.push(pc.dim("─".repeat(40)));
  lines.push(plan.body);
  return lines.join("\n");
}

function openEditor(path: string): Promise<void> {
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
  return new Promise((resolve, reject) => {
    const child = spawn(editor, [path], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", () => resolve());
  });
}

function runGit(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += String(c);
    });
    child.stderr.on("data", (c) => {
      stderr += String(c);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

export function registerPlanCommands(
  program: Command,
  runSafely: (fn: () => Promise<void>) => Promise<void>,
): void {
  const plan = program.command("plan").description("Author and manage durable Markdown plans.");

  // ── 02.4 read/create ──────────────────────────────────────────────
  plan
    .command("new")
    .argument("<brief...>", "One-line description of the work.")
    .option("--title <title>", "Plan title (defaults to the brief).")
    .option("--no-edit", "Skip opening $EDITOR after creating the draft.")
    .description("Create a draft plan and open it in $EDITOR.")
    .action(async (briefParts: string[], opts: { title?: string; edit?: boolean }) => {
      await runSafely(async () => {
        const { lifecycle } = makeLifecycle();
        const namespace = await resolveNamespaceFrom();
        const brief = briefParts.join(" ");
        const created = await lifecycle.create({
          namespace,
          title: opts.title ?? brief,
          brief,
        });
        console.log(`${pc.green("created")} ${created.id} (${statusColor(created.status)})`);
        if (opts.edit !== false && process.stdin.isTTY) {
          await openEditor(created.path);
          // Re-read to validate the developer's edits.
          const { store } = makeLifecycle();
          await store.readPlan(created.id);
          console.log(pc.dim("saved and validated"));
        }
        console.log(pc.dim(relative(process.cwd(), created.path)));
      });
    });

  plan
    .command("list")
    .option("--status <status>", "Filter by status.")
    .option("--all", "Include completed and abandoned plans.")
    .description("List plans in the current namespace.")
    .action(async (opts: { status?: string; all?: boolean }) => {
      await runSafely(async () => {
        const { store } = makeLifecycle();
        const namespace = await resolveNamespaceFrom();
        let plans = (await store.listPlans()).filter((p) => p.namespace === namespace);
        if (opts.status) plans = plans.filter((p) => p.status === opts.status);
        else if (!opts.all)
          plans = plans.filter((p) => p.status !== "complete" && p.status !== "abandoned");
        if (plans.length === 0) {
          console.log(pc.dim("no plans"));
          return;
        }
        for (const p of plans) {
          console.log(`${statusColor(p.status).padEnd(20)} ${pc.bold(p.title)}  ${pc.dim(p.id)}`);
        }
      });
    });

  plan
    .command("show")
    .argument("<id>")
    .description("Show a single plan.")
    .action(async (id: string) => {
      await runSafely(async () => {
        const { store } = makeLifecycle();
        console.log(renderPlan(await store.readPlan(id)));
      });
    });

  plan
    .command("edit")
    .argument("<id>")
    .description("Open a plan in $EDITOR and validate on save.")
    .action(async (id: string) => {
      await runSafely(async () => {
        const { store } = makeLifecycle();
        const existing = await store.readPlan(id);
        await openEditor(existing.path);
        await store.readPlan(id);
        console.log(pc.dim("saved and validated"));
      });
    });

  // ── 02.5 lifecycle ────────────────────────────────────────────────
  plan
    .command("approve")
    .argument("<id>")
    .description("Promote a draft to approved (one active plan per namespace).")
    .action(async (id: string) => {
      await runSafely(async () => {
        const { lifecycle } = makeLifecycle();
        const next = await lifecycle.approve(id);
        console.log(`${next.id} → ${statusColor(next.status)}`);
      });
    });

  plan
    .command("start")
    .argument("<id>")
    .description("Move an approved plan to executing.")
    .action(async (id: string) => {
      await runSafely(async () => {
        const { lifecycle } = makeLifecycle();
        const next = await lifecycle.start(id);
        console.log(`${next.id} → ${statusColor(next.status)}`);
      });
    });

  plan
    .command("complete")
    .argument("<id>")
    .option("--commit <sha>", "Git commit the plan was completed in.")
    .option("--notes <text>", "Completion notes.")
    .description("Mark an executing plan complete.")
    .action(async (id: string, opts: { commit?: string; notes?: string }) => {
      await runSafely(async () => {
        const { lifecycle } = makeLifecycle();
        const next = await lifecycle.complete(id, {
          ...(opts.commit ? { commitSha: opts.commit } : {}),
          ...(opts.notes ? { notes: opts.notes } : {}),
        });
        if (!opts.commit) console.log(pc.yellow("note: no --commit supplied"));
        console.log(`${next.id} → ${statusColor(next.status)}`);
      });
    });

  plan
    .command("abandon")
    .argument("<id>")
    .option("--reason <text>", "Why the plan was abandoned.")
    .description("Abandon a plan without completing it.")
    .action(async (id: string, opts: { reason?: string }) => {
      await runSafely(async () => {
        const { lifecycle } = makeLifecycle();
        const next = await lifecycle.abandon(id, opts.reason ? { reason: opts.reason } : {});
        console.log(`${next.id} → ${statusColor(next.status)}`);
      });
    });

  plan
    .command("diff")
    .argument("<id>")
    .option("--from <ref>", "Git ref to compare from.", "HEAD")
    .option("--to <ref>", "Git ref to compare to.")
    .description("Show the git diff of a plan file between two revisions.")
    .action(async (id: string, opts: { from: string; to?: string }) => {
      await runSafely(async () => {
        const { store } = makeLifecycle();
        const plan = await store.readPlan(id);
        const relPath = relative(process.cwd(), plan.path);
        const args = ["diff", opts.from, ...(opts.to ? [opts.to] : []), "--", relPath];
        const result = await runGit(args);
        if (result.stdout.trim().length === 0) {
          console.log(pc.dim("no changes"));
        } else {
          process.stdout.write(result.stdout);
        }
        if (result.code !== 0 && result.stderr) process.stderr.write(result.stderr);
      });
    });

  // ── 02.7 policy ───────────────────────────────────────────────────
  plan
    .command("policy")
    .argument("[mode]", `One of: ${PLAN_POLICIES.join(", ")}. Omit to read the current value.`)
    .description("Read or set the plan policy (off | suggest | required).")
    .action(async (mode: string | undefined) => {
      await runSafely(async () => {
        if (mode === undefined) {
          console.log(await loadPlanPolicy());
          return;
        }
        if (!(PLAN_POLICIES as readonly string[]).includes(mode)) {
          throw new Error(`Invalid policy "${mode}". Use one of: ${PLAN_POLICIES.join(", ")}.`);
        }
        await setPlanPolicy(mode as PlanPolicy);
        console.log(`${pc.green("plan policy")} = ${mode}`);
      });
    });
}
