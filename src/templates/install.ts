import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defaultRulesFile, renderWorkflowTemplate, type WorkflowClient } from "./workflow.js";

/**
 * Safe, visible install of the workflow template into a client's Markdown rules
 * file. The template is written inside HTML-comment markers so:
 *   - updates are idempotent (the block is replaced, not appended again);
 *   - the user's own content around the block is preserved untouched;
 *   - the markers make it obvious exactly what CodeBuddy manages.
 * No hidden mutation: the caller sees the resolved path and the action taken.
 */

const START_MARKER = "<!-- codebuddy:workflow:start -->";
const END_MARKER = "<!-- codebuddy:workflow:end -->";

export type InstallAction = "created" | "added" | "updated" | "unchanged";

export type InstallResult = {
  path: string;
  client: WorkflowClient;
  action: InstallAction;
};

export type InstallRulesOptions = {
  client: WorkflowClient;
  projectRoot?: string;
  /** Override the target file (defaults to CLAUDE.md / AGENTS.md). */
  targetPath?: string;
};

export function renderManagedBlock(client: WorkflowClient): string {
  return `${START_MARKER}\n${renderWorkflowTemplate(client)}\n${END_MARKER}\n`;
}

export async function installWorkflowRules(options: InstallRulesOptions): Promise<InstallResult> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const path = options.targetPath ?? join(projectRoot, defaultRulesFile(options.client));

  const existing = await readIfPresent(path);
  const block = renderManagedBlock(options.client);
  const { content, action } = upsertBlock(existing, block);

  if (action === "unchanged") return { path, client: options.client, action };
  await writeFile(path, content, "utf8");
  return { path, client: options.client, action };
}

/** Compute the new file content and what changed, without touching disk. */
export function upsertBlock(
  existing: string | null,
  block: string,
): { content: string; action: InstallAction } {
  if (existing === null) return { content: block, action: "created" };

  const start = existing.indexOf(START_MARKER);
  const end = existing.indexOf(END_MARKER);
  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + END_MARKER.length).replace(/^\n/, "");
    const replaced = `${before}${block}${after}`;
    return { content: replaced, action: replaced === existing ? "unchanged" : "updated" };
  }

  // No managed block yet — append, keeping the user's content intact.
  const separator =
    existing.length === 0 || existing.endsWith("\n\n")
      ? ""
      : existing.endsWith("\n")
        ? "\n"
        : "\n\n";
  return { content: `${existing}${separator}${block}`, action: "added" };
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
