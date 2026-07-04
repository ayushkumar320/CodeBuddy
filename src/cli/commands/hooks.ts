import { relative } from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { runCaptureHook, runContextHook, runStageHook } from "../../hooks/runtime.js";
import {
  claudeSettingsPath,
  hooksInstalled,
  readSettings,
  removeHooks,
  upsertHooks,
  writeSettings,
} from "../../hooks/settings.js";

/**
 * `codebuddy hooks` makes recall and capture deterministic by wiring CodeBuddy
 * into Claude Code's lifecycle hooks. The management commands (install/
 * uninstall/status) edit `.claude/settings.json` idempotently and visibly. The
 * runtime commands (context/stage/capture) are what the hooks invoke — they read
 * the hook payload on stdin and are strictly fail-soft: a hook must never break
 * the user's turn, so they always exit 0.
 */
export function registerHooksCommands(
  program: Command,
  runSafely: (fn: () => Promise<void>) => Promise<void>,
): void {
  const hooks = program
    .command("hooks")
    .description("Enforce automatic recall/capture via Claude Code lifecycle hooks.");

  hooks
    .command("install")
    .option("--client <client>", "Only 'claude' is supported today.", "claude")
    .description("Add CodeBuddy's recall/capture hooks to .claude/settings.json (idempotent).")
    .action(async (opts: { client?: string }) => {
      await runSafely(async () => {
        assertClaude(opts.client);
        const path = claudeSettingsPath();
        const { settings, changed } = upsertHooks(await readSettings(path));
        if (changed) await writeSettings(path, settings);
        const where = relative(process.cwd(), path) || path;
        console.log(
          `${changed ? pc.green("installed") : pc.dim("unchanged")} CodeBuddy hooks in ${where}`,
        );
        console.log(
          pc.dim(
            "  UserPromptSubmit→recall · PostToolUse(edit)→stage · Stop→capture. Restart Claude Code to activate.",
          ),
        );
      });
    });

  hooks
    .command("uninstall")
    .option("--client <client>", "Only 'claude' is supported today.", "claude")
    .description("Remove CodeBuddy's hooks from .claude/settings.json (user hooks untouched).")
    .action(async (opts: { client?: string }) => {
      await runSafely(async () => {
        assertClaude(opts.client);
        const path = claudeSettingsPath();
        const { settings, changed } = removeHooks(await readSettings(path));
        if (changed) await writeSettings(path, settings);
        console.log(
          changed ? pc.yellow("removed CodeBuddy hooks") : pc.dim("no CodeBuddy hooks found"),
        );
      });
    });

  hooks
    .command("status")
    .description("Report whether CodeBuddy hooks are installed.")
    .action(async () => {
      await runSafely(async () => {
        const installed = hooksInstalled(await readSettings(claudeSettingsPath()));
        console.log(
          installed
            ? pc.green("CodeBuddy hooks: installed")
            : pc.dim("CodeBuddy hooks: not installed"),
        );
      });
    });

  // ── runtime commands invoked by the hooks (read stdin, fail-soft) ──

  hooks
    .command("context")
    .description("[hook] Emit compact project context for injection at prompt submit.")
    .action(async () => {
      await failSoft(async () => {
        const input = await readHookInput();
        const block = await runContextHook(input);
        if (block.trim()) process.stdout.write(`${block}\n`);
      });
    });

  hooks
    .command("stage")
    .description("[hook] Record the files an edit tool just changed.")
    .action(async () => {
      await failSoft(async () => {
        const input = await readHookInput();
        await runStageHook(input);
      });
    });

  hooks
    .command("capture")
    .description("[hook] Capture durable memory from the turn's change set.")
    .action(async () => {
      await failSoft(async () => {
        const input = await readHookInput();
        const { changedFiles, result } = await runCaptureHook(input);
        if (result) {
          process.stderr.write(
            `codebuddy: captured from ${changedFiles.length} changed file(s) — ` +
              `${result.saved.length} saved, ${result.queuedForReview.length} queued\n`,
          );
        }
      });
    });
}

function assertClaude(client: string | undefined): void {
  if ((client ?? "claude") !== "claude") {
    throw new Error("Only --client claude is supported today. Codex hook support is planned.");
  }
}

/**
 * Runtime hook commands must never fail the user's turn. Swallow everything and
 * exit 0; surface problems on stderr only.
 */
async function failSoft(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    process.stderr.write(`codebuddy hook: ${(error as Error).message}\n`);
  }
}

async function readHookInput(): Promise<import("../../hooks/runtime.js").HookInput> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
