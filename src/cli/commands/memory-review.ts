import { spawn } from "node:child_process";
import { relative } from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { approveReviewItem } from "../../memory-extract/engine.js";
import { type ReviewItem, ReviewStore } from "../../memory-extract/review-store.js";

/**
 * The review queue is file-based Markdown under `.codebuddy/memory/review/`;
 * these commands need no database. Approving promotes an item to a durable
 * fact; rejecting deletes it. Nothing is ever committed automatically.
 */
export function registerMemoryCommands(
  program: Command,
  runSafely: (fn: () => Promise<void>) => Promise<void>,
): void {
  const memory = program.command("memory").description("Inspect and curate CodeBuddy memory.");
  const review = memory
    .command("review")
    .description("Review memory candidates captured automatically after turns.");

  review
    .command("list", { isDefault: true })
    .option("--json", "Print machine-readable JSON.")
    .description("List pending review candidates.")
    .action(async (opts: { json?: boolean }) => {
      await runSafely(async () => {
        const items = await new ReviewStore().list();
        if (opts.json) {
          console.log(JSON.stringify(items, null, 2));
          return;
        }
        if (items.length === 0) {
          console.log(pc.dim("no pending review items"));
          return;
        }
        for (const item of items) console.log(renderRow(item));
        console.log(pc.dim(`\n${items.length} pending. approve <id> | reject <id> | show <id>`));
      });
    });

  review
    .command("show")
    .argument("<id>")
    .description("Show a single review candidate.")
    .action(async (id: string) => {
      await runSafely(async () => {
        console.log(renderItem(await new ReviewStore().read(id)));
      });
    });

  review
    .command("approve")
    .argument("<id>")
    .description("Promote a review candidate to a durable fact and remove it from the queue.")
    .action(async (id: string) => {
      await runSafely(async () => {
        const factId = await approveReviewItem(id);
        console.log(`${pc.green("approved")} ${id} → ${factId}`);
      });
    });

  review
    .command("reject")
    .argument("<id>")
    .description("Discard a review candidate without saving it.")
    .action(async (id: string) => {
      await runSafely(async () => {
        const store = new ReviewStore();
        await store.read(id); // Validate existence for a clear error.
        await store.delete(id);
        console.log(`${pc.yellow("rejected")} ${id}`);
      });
    });

  review
    .command("edit")
    .argument("<id>")
    .description("Open a review candidate in $EDITOR and re-validate on save.")
    .action(async (id: string) => {
      await runSafely(async () => {
        const store = new ReviewStore();
        const item = await store.read(id);
        await openEditor(item.path);
        await store.read(id); // Re-parse to reject malformed edits loudly.
        console.log(pc.dim("saved and validated"));
      });
    });
}

function renderRow(item: ReviewItem): string {
  const flag = item.sensitive ? pc.red(" ⚠ sensitive") : "";
  return `${classColor(item.class)}  ${pc.dim(item.id)}  ${truncate(item.content, 70)}${flag}`;
}

function renderItem(item: ReviewItem): string {
  const lines = [
    `${classColor(item.class)}  ${pc.dim(item.id)}`,
    `${pc.bold("reason:")} ${item.reason}`,
    `${pc.bold("confidence:")} ${item.confidence.toFixed(2)}`,
    `${pc.bold("triple:")} ${item.subject} · ${item.predicate} · ${item.object}`,
  ];
  if (item.paths.length > 0) lines.push(`${pc.bold("paths:")} ${item.paths.join(", ")}`);
  if (item.severity) lines.push(`${pc.bold("severity:")} ${item.severity}`);
  if (item.sensitive) lines.push(pc.red(`⚠ sensitive: ${item.sensitiveReasons.join(", ")}`));
  lines.push("", item.content, "", pc.dim(relative(process.cwd(), item.path)));
  return lines.join("\n");
}

function classColor(memoryClass: ReviewItem["class"]): string {
  switch (memoryClass) {
    case "incident":
      return pc.red(memoryClass);
    case "decision":
      return pc.cyan(memoryClass);
    case "fact":
      return pc.green(memoryClass);
    case "note":
      return pc.yellow(memoryClass);
    default:
      return pc.dim(memoryClass);
  }
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function openEditor(path: string): Promise<void> {
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
  return new Promise((resolvePromise, reject) => {
    const child = spawn(editor, [path], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", () => resolvePromise());
  });
}
