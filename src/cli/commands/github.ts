import type { Command } from "commander";
import pc from "picocolors";
import { installGitHubWorkflow } from "../../integrations/github.js";

export function registerGitHubCommands(
  program: Command,
  runSafely: (fn: () => Promise<void>) => Promise<void>,
): void {
  const github = program.command("github").description("Install GitHub workflow integrations.");
  github
    .command("install")
    .option("--force", "Replace an existing CodeBuddy workflow.")
    .description("Install the PR change-safety report workflow.")
    .action(async (opts: { force?: boolean }) => {
      await runSafely(async () => {
        const result = await installGitHubWorkflow(process.cwd(), {
          ...(opts.force !== undefined ? { force: opts.force } : {}),
        });
        console.log(`${result.created ? "installed" : "already present"} ${pc.dim(result.path)}`);
        if (result.created) console.log("Commit this workflow to enable CodeBuddy PR reports.");
      });
    });
}
