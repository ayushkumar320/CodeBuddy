import type { Command } from "commander";
import pc from "picocolors";
import { indexRepository } from "../../indexer/engine.js";
import type { IndexResult } from "../../indexer/types.js";
import { watchRepository } from "../../indexer/watch.js";

/**
 * `index` and `watch` are file-based (they read the working tree and write a
 * cache manifest) and need no database connection.
 */
export function registerIndexCommands(
  program: Command,
  runSafely: (fn: () => Promise<void>) => Promise<void>,
): void {
  program
    .command("index")
    .option("--full", "Re-summarize every file, ignoring existing content hashes.")
    .option("--json", "Print machine-readable JSON.")
    .description("Index the repository: content hashes and lightweight file summaries.")
    .action(async (opts: { full?: boolean; json?: boolean }) => {
      await runSafely(async () => {
        const result = await indexRepository({ ...(opts.full ? { full: true } : {}) });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        printResult(result);
      });
    });

  program
    .command("watch")
    .option("--debounce <ms>", "Coalesce file-change bursts within this window.", Number)
    .description("Watch the repository and incrementally re-index on change (Ctrl+C to stop).")
    .action(async (opts: { debounce?: number }) => {
      await runSafely(async () => {
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        console.log(pc.dim("watching for changes… press Ctrl+C to stop"));
        await watchRepository({
          ...(opts.debounce !== undefined ? { debounceMs: opts.debounce } : {}),
          signal: controller.signal,
          onIndex: (result) => printResult(result, true),
          onError: (error) => console.error(pc.red(error.message)),
        });
        console.log(pc.dim("stopped watching"));
      });
    });
}

function printResult(result: IndexResult, compact = false): void {
  const summary = `${result.totalIndexed} indexed (${pc.green(`+${result.added}`)} ${pc.yellow(`~${result.changed}`)} ${pc.dim(`=${result.unchanged}`)} ${pc.red(`-${result.removed}`)}) in ${result.durationMs}ms`;
  console.log(compact ? pc.dim(summary) : summary);
  if (result.skipped > 0)
    console.log(pc.dim(`  ${result.skipped} skipped (too large or unreadable)`));
  for (const error of result.errors) console.log(pc.red(`  ${error.path}: ${error.error}`));
}
