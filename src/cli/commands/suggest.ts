import { basename } from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { readConfigFile } from "../../core/config-file.js";
import { generateSuggestions } from "../../suggest/engine.js";
import type { Suggestion, SuggestionSeverity } from "../../suggest/types.js";

/**
 * `codebuddy suggest` is read-only and file-based (risk, plan, map, memory),
 * so it runs without a database — the same lightweight path as risk/context.
 */
async function resolveNamespace(cwd = process.cwd()): Promise<string> {
  if (process.env.CODEBUDDY_NAMESPACE) return process.env.CODEBUDDY_NAMESPACE;
  const file = await readConfigFile(cwd);
  return file.namespace ?? basename(cwd);
}

function parsePaths(value: string): string[] {
  return value
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean);
}

export function registerSuggestCommand(
  program: Command,
  runSafely: (fn: () => Promise<void>) => Promise<void>,
): void {
  program
    .command("suggest")
    .option("--paths <paths>", "Comma-separated repo-relative paths to review.")
    .option("--plan <id>", "Review the files listed in a plan.")
    .option("--git", "Review current git changes.")
    .option("--limit <n>", "Maximum suggestions to show.", Number)
    .option("--json", "Print machine-readable JSON.")
    .description("Suggest evidence-backed, read-only code-quality improvements.")
    .action(
      async (opts: {
        paths?: string;
        plan?: string;
        git?: boolean;
        limit?: number;
        json?: boolean;
      }) => {
        await runSafely(async () => {
          const namespace = await resolveNamespace();
          const result = await generateSuggestions({
            namespace,
            ...(opts.paths ? { paths: parsePaths(opts.paths) } : {}),
            ...(opts.plan ? { planId: opts.plan } : {}),
            ...(opts.git !== undefined ? { useGit: opts.git } : {}),
            ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
          });
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          printSuggestions(result.suggestions);
          console.log(
            pc.dim(
              `\n${result.stats.produced} suggestion(s) across ${result.stats.pathsConsidered} path(s)`,
            ),
          );
        });
      },
    );
}

function printSuggestions(suggestions: Suggestion[]): void {
  if (suggestions.length === 0) {
    console.log(pc.dim("no suggestions — nothing high-signal to report"));
    return;
  }
  for (const suggestion of suggestions) {
    console.log(`${severityBadge(suggestion.severity)} ${pc.bold(suggestion.title)}`);
    console.log(`  ${suggestion.detail}`);
    for (const evidence of suggestion.evidence) {
      console.log(pc.dim(`  ↳ ${evidence.kind}: ${evidence.detail}`));
    }
    if (suggestion.commandHint) console.log(pc.dim(`  → ${suggestion.commandHint}`));
  }
}

function severityBadge(severity: SuggestionSeverity): string {
  switch (severity) {
    case "high":
      return pc.red("[high]");
    case "medium":
      return pc.yellow("[med ]");
    case "low":
      return pc.cyan("[low ]");
    default:
      return pc.dim("[info]");
  }
}
