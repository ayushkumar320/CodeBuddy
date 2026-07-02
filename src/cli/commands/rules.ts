import { relative } from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { installWorkflowRules } from "../../templates/install.js";
import {
  clientDisplayName,
  renderWorkflowTemplate,
  WORKFLOW_CLIENTS,
  type WorkflowClient,
} from "../../templates/workflow.js";

/**
 * `codebuddy rules` prints and installs the client workflow templates. Install
 * is file-based and visible: it writes a clearly-marked managed block into the
 * client's Markdown rules file (CLAUDE.md / AGENTS.md) and reports exactly what
 * changed. The user stays in control of their client config.
 */
function parseClient(value: string | undefined): WorkflowClient {
  const client = value ?? "claude";
  if (!(WORKFLOW_CLIENTS as readonly string[]).includes(client)) {
    throw new Error(`Unknown client "${client}". Use one of: ${WORKFLOW_CLIENTS.join(", ")}.`);
  }
  return client as WorkflowClient;
}

export function registerRulesCommands(
  program: Command,
  runSafely: (fn: () => Promise<void>) => Promise<void>,
): void {
  const rules = program
    .command("rules")
    .description("Print or install the Claude/Codex workflow templates.");

  rules
    .command("show")
    .option("--client <client>", `One of: ${WORKFLOW_CLIENTS.join(", ")}.`, "claude")
    .description("Print the workflow template for a client.")
    .action(async (opts: { client?: string }) => {
      await runSafely(async () => {
        console.log(renderWorkflowTemplate(parseClient(opts.client)));
      });
    });

  rules
    .command("install")
    .option("--client <client>", `One of: ${WORKFLOW_CLIENTS.join(", ")}.`, "claude")
    .option("--path <file>", "Override the target rules file.")
    .description("Install/update the workflow template in the client's rules file (managed block).")
    .action(async (opts: { client?: string; path?: string }) => {
      await runSafely(async () => {
        const client = parseClient(opts.client);
        const result = await installWorkflowRules({
          client,
          ...(opts.path ? { targetPath: opts.path } : {}),
        });
        const where = relative(process.cwd(), result.path) || result.path;
        console.log(
          `${actionLabel(result.action)} ${clientDisplayName(client)} workflow in ${where}`,
        );
        if (result.action !== "unchanged") {
          console.log(pc.dim("  managed block between codebuddy:workflow markers; safe to re-run"));
        }
      });
    });
}

function actionLabel(action: string): string {
  switch (action) {
    case "created":
      return pc.green("created");
    case "added":
      return pc.green("added");
    case "updated":
      return pc.cyan("updated");
    default:
      return pc.dim("unchanged");
  }
}
