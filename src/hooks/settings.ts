import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { writeAtomic } from "../core/markdown-store-fs.js";

/**
 * Installs CodeBuddy's lifecycle hooks into a client's settings JSON. Unlike the
 * Markdown workflow templates, settings files are JSON, so we can't use comment
 * markers — instead every CodeBuddy hook command starts with `codebuddy hooks`,
 * which is how we recognise (and cleanly remove) our own entries. Install is
 * idempotent and never touches hooks the user added themselves.
 *
 * Claude Code hooks fire deterministically, independent of the model's choices:
 *   - UserPromptSubmit → `codebuddy hooks context`  (recall, injected into prompt)
 *   - PostToolUse(Edit|Write|MultiEdit) → `codebuddy hooks stage`  (track edits)
 *   - Stop → `codebuddy hooks capture`  (capture durable memory at turn end)
 */

export const HOOK_COMMAND_PREFIX = "codebuddy hooks";

export type HookCommand = { type: "command"; command: string };
export type HookGroup = { matcher?: string; hooks: HookCommand[] };
export type HookSettings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

type HookDef = { event: string; command: string; matcher?: string };

const HOOK_DEFS: HookDef[] = [
  { event: "UserPromptSubmit", command: `${HOOK_COMMAND_PREFIX} context` },
  {
    event: "PostToolUse",
    matcher: "Edit|Write|MultiEdit",
    command: `${HOOK_COMMAND_PREFIX} stage`,
  },
  { event: "Stop", command: `${HOOK_COMMAND_PREFIX} capture` },
];

export function claudeSettingsPath(repositoryRoot = process.cwd()): string {
  return join(resolve(repositoryRoot), ".claude", "settings.json");
}

/** Merge CodeBuddy's hook entries into a settings object. Idempotent. */
export function upsertHooks(settings: HookSettings): { settings: HookSettings; changed: boolean } {
  const next: HookSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const hooks = next.hooks as Record<string, HookGroup[]>;
  let changed = false;

  for (const def of HOOK_DEFS) {
    const groups = [...(hooks[def.event] ?? [])];
    const existingIndex = groups.findIndex((group) =>
      group.hooks?.some((hook) => hook.command === def.command),
    );
    if (existingIndex === -1) {
      groups.push({
        ...(def.matcher ? { matcher: def.matcher } : {}),
        hooks: [{ type: "command", command: def.command }],
      });
      changed = true;
    } else {
      // The command exists, but possibly under a stale matcher (e.g. an older
      // install with matcher:"Edit" before MultiEdit coverage). Reconcile the
      // group's matcher so coverage matches the current contract.
      const existing = groups[existingIndex];
      if (existing && (def.matcher ?? undefined) !== (existing.matcher ?? undefined)) {
        const { matcher: _oldMatcher, ...rest } = existing;
        groups[existingIndex] = def.matcher ? { ...rest, matcher: def.matcher } : rest;
        changed = true;
      }
    }
    hooks[def.event] = groups;
  }

  return { settings: next, changed };
}

/** Remove every CodeBuddy hook entry, leaving user hooks intact. */
export function removeHooks(settings: HookSettings): { settings: HookSettings; changed: boolean } {
  if (!settings.hooks) return { settings, changed: false };
  const next: HookSettings = { ...settings, hooks: { ...settings.hooks } };
  const hooks = next.hooks as Record<string, HookGroup[]>;
  let changed = false;

  for (const event of Object.keys(hooks)) {
    const keptGroups: HookGroup[] = [];
    for (const group of hooks[event] ?? []) {
      // Filter INSIDE groups: a user group mixing our hook with their own
      // commands must keep theirs. Dropping whole groups used to silently
      // delete user hooks that happened to share a group with ours.
      const keptHooks = (group.hooks ?? []).filter(
        (hook) => !hook.command?.startsWith(HOOK_COMMAND_PREFIX),
      );
      if (keptHooks.length !== (group.hooks ?? []).length) changed = true;
      if (keptHooks.length === 0) continue; // group was entirely ours
      keptGroups.push({ ...group, hooks: keptHooks });
    }
    if (keptGroups.length === 0) delete hooks[event];
    else hooks[event] = keptGroups;
  }

  return { settings: next, changed };
}

export function hooksInstalled(settings: HookSettings): boolean {
  const hooks = settings.hooks ?? {};
  return Object.values(hooks).some((groups) =>
    groups.some((group) => group.hooks?.some((h) => h.command?.startsWith(HOOK_COMMAND_PREFIX))),
  );
}

export async function readSettings(path: string): Promise<HookSettings> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as HookSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function writeSettings(path: string, settings: HookSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Atomic so a crash mid-write can never truncate the user's settings.json.
  await writeAtomic(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o644 });
}
