import type { Command } from "commander";
import pc from "picocolors";
import { runEvaluation } from "../../eval/runner.js";
import type { EvaluationResult } from "../../eval/types.js";

export function registerEvalCommand(
  program: Command,
  runSafely: (fn: () => Promise<void>) => Promise<void>,
): void {
  program
    .command("eval")
    .argument("[dataset]", "Evaluation dataset JSON path.")
    .option("--json", "Print machine-readable JSON.")
    .description("Run the committed change-readiness evaluation dataset.")
    .action(async (dataset: string | undefined, opts: { json?: boolean }) => {
      await runSafely(async () => {
        const result = await runEvaluation(dataset ? { datasetPath: dataset } : {});
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else printEvaluation(result);
        if (!result.passed) process.exitCode = 1;
      });
    });
}

function printEvaluation(result: EvaluationResult): void {
  console.log(
    `${result.passed ? pc.green("passed") : pc.red("failed")} ${result.summary.passed}/${result.summary.total} evaluation cases`,
  );
  for (const item of result.cases) {
    console.log(`  ${item.passed ? pc.green("✓") : pc.red("×")} ${item.id}`);
    if (!item.passed) for (const failure of item.failures) console.log(pc.dim(`    ${failure}`));
  }
  console.log(pc.dim(`dataset: ${result.datasetPath}`));
}
