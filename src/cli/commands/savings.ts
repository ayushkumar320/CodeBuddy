import type { Command } from "commander";
import pc from "picocolors";
import { computeRepoSavings } from "../../savings/engine.js";
import type { RepoSavings } from "../../savings/types.js";

/**
 * `codebuddy savings` reports repo-wide token savings measured from the index
 * manifest: the cost of every indexed file's raw source versus its summary.
 * File-based; needs no database. Prompts to run `codebuddy index` when there is
 * nothing indexed yet.
 */
export function registerSavingsCommand(
  program: Command,
  runSafely: (fn: () => Promise<void>) => Promise<void>,
): void {
  program
    .command("savings")
    .option("--json", "Print machine-readable JSON.")
    .description("Show token savings from sending file summaries instead of raw source.")
    .action(async (opts: { json?: boolean }) => {
      await runSafely(async () => {
        const result = await computeRepoSavings();
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        printSavings(result);
      });
    });
}

function printSavings(result: RepoSavings): void {
  const { savings, project } = result;
  if (!savings.available) {
    console.log(pc.dim(savings.note ?? "no savings data"));
    return;
  }

  const percent = Math.round((1 - savings.compressionRatio) * 100);
  console.log(
    `${pc.bold("theoretical raw-source compression")} ${pc.green(`${savings.savedTokens.toLocaleString()} tokens`)} (${percent}% smaller)`,
  );
  console.log(
    pc.dim(
      `  baseline ${savings.baselineTokens.toLocaleString()} → returned ${savings.returnedTokens.toLocaleString()} across ${savings.representedFiles} file(s)`,
    ),
  );
  console.log(
    `${pc.bold("project")} ${project.files} files, ${project.lines.toLocaleString()} lines, ${Object.entries(
      project.languages,
    )
      .map(([lang, count]) => `${lang}:${count}`)
      .join(" ")}`,
  );
  if (project.topDirectories.length > 0) {
    console.log(pc.bold("top directories:"));
    for (const dir of project.topDirectories) {
      console.log(
        `  ${dir.directory.padEnd(20)} ${pc.dim(`${dir.files} files, ${dir.lines} lines`)}`,
      );
    }
  }
}
