import type { Command } from "commander";
import pc from "picocolors";
import { resolveNamespaceFrom } from "../../core/config-file.js";
import { recordChangeOutcome } from "../../learning/outcomes.js";

export function registerLearnCommand(
  program: Command,
  runSafely: (fn: () => Promise<void>) => Promise<void>,
): void {
  const learn = program.command("learn").description("Record verified team change outcomes.");
  learn
    .command("outcome")
    .requiredOption("--outcome <outcome>", "safe or regression")
    .requiredOption("--paths <paths>", "Comma-separated repo-relative paths.")
    .requiredOption("--summary <summary>", "What happened and why it matters.")
    .option("--severity <severity>", "Incident severity: low, medium, high, or critical.")
    .option("--commit <sha>", "Commit associated with the outcome.")
    .option("--plan <id>", "Plan associated with the outcome.")
    .description("Write an explicit, reviewable outcome into shared Markdown memory.")
    .action(
      async (opts: {
        outcome: string;
        paths: string;
        summary: string;
        severity?: "low" | "medium" | "high" | "critical";
        commit?: string;
        plan?: string;
      }) => {
        await runSafely(async () => {
          if (opts.outcome !== "safe" && opts.outcome !== "regression") {
            throw new Error("--outcome must be safe or regression.");
          }
          const result = await recordChangeOutcome({
            namespace: await resolveNamespaceFrom(),
            outcome: opts.outcome,
            paths: opts.paths
              .split(",")
              .map((path) => path.trim())
              .filter(Boolean),
            summary: opts.summary,
            ...(opts.severity ? { severity: opts.severity } : {}),
            ...(opts.commit ? { commit: opts.commit } : {}),
            ...(opts.plan ? { planId: opts.plan } : {}),
          });
          console.log(`${pc.green("recorded")} ${result.id} (${result.category})`);
          console.log(pc.dim(result.path));
        });
      },
    );
}
