import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { buildBeforeEditContext, buildBootstrapContext } from "../context/engine.js";
import type { BeforeEditContext, BootstrapContext } from "../context/types.js";
import { readConfigFile } from "../core/config-file.js";
import { captureAfterTurn } from "../memory-extract/engine.js";
import type { AfterTurnResult } from "../memory-extract/types.js";
import { HookStagingStore } from "./staging.js";

/**
 * The runtime side of `codebuddy hooks`. Each function is the deterministic
 * action a Claude Code hook triggers, independent of whether the model chose to
 * call anything:
 *   - context: recall — compact project context, injected at prompt submit.
 *   - stage:   record the files an edit tool just changed.
 *   - capture: at turn end, capture durable memory from the real change set.
 *
 * All are best-effort: a hook must never break the user's turn, so callers wrap
 * these and always exit 0.
 */

/** The subset of a Claude Code hook payload CodeBuddy reads. */
export type HookInput = {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

const CONTEXT_BLOCK_MAX_CHARS = 1800;

async function resolveNamespace(repositoryRoot: string): Promise<string> {
  if (process.env.CODEBUDDY_NAMESPACE) return process.env.CODEBUDDY_NAMESPACE;
  const file = await readConfigFile(repositoryRoot);
  return file.namespace ?? basename(repositoryRoot);
}

/** UserPromptSubmit → a compact, injectable context block (recall). */
export async function runContextHook(input: HookInput): Promise<string> {
  const repositoryRoot = resolve(input.cwd ?? process.cwd());
  const namespace = await resolveNamespace(repositoryRoot);

  const bootstrap = await buildBootstrapContext({ repositoryRoot, namespace });
  let beforeEdit: BeforeEditContext | null = null;
  try {
    beforeEdit = await buildBeforeEditContext({ repositoryRoot, namespace, useGit: true });
  } catch {
    beforeEdit = null;
  }
  return renderContextBlock(bootstrap, beforeEdit);
}

/** PostToolUse(edit) → stage the changed paths for capture. */
export async function runStageHook(input: HookInput): Promise<string[]> {
  const repositoryRoot = resolve(input.cwd ?? process.cwd());
  const paths = extractEditedPaths(input.tool_input).map((path) =>
    toRepoRelative(repositoryRoot, path),
  );
  await new HookStagingStore(repositoryRoot).add(input.session_id ?? "default", paths);
  return paths;
}

export type CaptureHookResult = {
  changedFiles: string[];
  result: AfterTurnResult | null;
};

/** Stop → capture durable memory from the staged change set + transcript. */
export async function runCaptureHook(input: HookInput): Promise<CaptureHookResult> {
  const repositoryRoot = resolve(input.cwd ?? process.cwd());
  const changedFiles = await new HookStagingStore(repositoryRoot).drain(
    input.session_id ?? "default",
  );
  if (changedFiles.length === 0) return { changedFiles, result: null };

  const namespace = await resolveNamespace(repositoryRoot);
  const summary = await deriveSummary(input.transcript_path, changedFiles);
  const result = await captureAfterTurn({ summary, changedFiles, namespace }, { repositoryRoot });
  return { changedFiles, result };
}

// ── helpers ─────────────────────────────────────────────────────────

/** Pull `file_path` fields out of a tool input (Edit/Write/MultiEdit shapes). */
export function extractEditedPaths(toolInput: Record<string, unknown> | undefined): string[] {
  if (!toolInput) return [];
  const paths: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim()) paths.push(value);
  };
  push(toolInput.file_path);
  push(toolInput.path);
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (edit && typeof edit === "object") push((edit as Record<string, unknown>).file_path);
    }
  }
  return [...new Set(paths)];
}

function toRepoRelative(repositoryRoot: string, path: string): string {
  const rel = isAbsolute(path) ? relative(repositoryRoot, path) : path;
  return rel.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Build a capture summary from the turn transcript (the last assistant message)
 * plus the change set. If the transcript can't be read, fall back to a plain
 * file list — which the conservative extractor will simply not turn into durable
 * facts, exactly the safe outcome.
 */
export async function deriveSummary(
  transcriptPath: string | undefined,
  changedFiles: string[],
): Promise<string> {
  const fileList = `Changed files: ${changedFiles.join(", ")}.`;
  const assistantText = transcriptPath ? await lastAssistantMessage(transcriptPath) : "";
  return assistantText ? `${assistantText}\n\n${fileList}` : fileList;
}

export async function lastAssistantMessage(transcriptPath: string): Promise<string> {
  try {
    const raw = await readFile(transcriptPath, "utf8");
    let latest = "";
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as Record<string, unknown>;
        const message = (entry.message ?? entry) as Record<string, unknown>;
        const role = message.role ?? entry.type;
        if (role !== "assistant") continue;
        const text = extractText(message.content);
        if (text) latest = text;
      } catch {
        // Skip malformed lines; transcripts are best-effort input.
      }
    }
    return latest.slice(0, 2000);
  } catch {
    return "";
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && (block as Record<string, unknown>).type === "text"
        ? String((block as Record<string, unknown>).text ?? "")
        : "",
    )
    .join(" ")
    .trim();
}

function renderContextBlock(
  bootstrap: BootstrapContext,
  beforeEdit: BeforeEditContext | null,
): string {
  const lines: string[] = ["## CodeBuddy project context (auto-recalled)"];
  lines.push(`project: ${bootstrap.project.namespace}`);
  lines.push(
    `plan: ${bootstrap.plan ? `${bootstrap.plan.title} (${bootstrap.plan.status})` : "none"} · policy=${bootstrap.policy}`,
  );
  if (bootstrap.policyRules.length > 0) {
    lines.push(`policies: ${bootstrap.policyRules.map((r) => `${r.id}(${r.weight})`).join(", ")}`);
  }
  if (bootstrap.incidents.length > 0) {
    lines.push(
      `incident hotspots: ${bootstrap.incidents.map((i) => `${i.subject} [${i.severity}]`).join("; ")}`,
    );
  }
  lines.push(
    `architecture: ${bootstrap.architecture.moduleCount} modules, ${bootstrap.architecture.edgeCount} edges`,
  );

  if (beforeEdit && beforeEdit.targetPaths.length > 0) {
    lines.push(`current changes: ${beforeEdit.targetPaths.slice(0, 8).join(", ")}`);
    if (beforeEdit.risks.items.length > 0) {
      lines.push(
        `risk: ${beforeEdit.risks.items
          .slice(0, 3)
          .map((item) => `${item.path}=${item.score}`)
          .join(", ")}`,
      );
    }
  }

  const savings = beforeEdit?.tokens.savings ?? bootstrap.tokens.savings;
  if (savings.available) {
    const percent = Math.round((1 - savings.compressionRatio) * 100);
    lines.push(`token savings: ~${savings.savedTokens} (${percent}% vs raw source)`);
  }

  return lines.join("\n").slice(0, CONTEXT_BLOCK_MAX_CHARS);
}
