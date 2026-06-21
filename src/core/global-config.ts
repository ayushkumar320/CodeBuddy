import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * User-level configuration shared across all projects on this machine.
 * Stored at ~/.codebuddy/global.json with 0600 permissions so the HF token
 * is never world-readable. Per-project namespace is NOT stored here — that
 * is implicit in the directory the user runs `codebuddy use` from.
 */

export const GLOBAL_DIR = ".codebuddy";
export const GLOBAL_FILE = "global.json";

const globalConfigSchema = z.object({
  hfToken: z.string().min(1).optional(),
  databaseUrl: z.string().min(1).optional(),
  // Where the codebuddy install lives on this machine. Cached so future
  // `codebuddy use` calls in unrelated projects can find the CLI entry
  // without re-resolving via process.argv every time.
  installPath: z.string().optional(),
});

export type GlobalConfig = z.infer<typeof globalConfigSchema>;

export function globalConfigPath(home = homedir()): string {
  return join(home, GLOBAL_DIR, GLOBAL_FILE);
}

export async function readGlobalConfig(home = homedir()): Promise<GlobalConfig> {
  const path = globalConfigPath(home);
  try {
    const raw = await readFile(path, "utf8");
    return globalConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function writeGlobalConfig(
  next: GlobalConfig,
  home = homedir(),
): Promise<{ path: string }> {
  const path = globalConfigPath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return { path };
}

export async function mergeGlobalConfig(
  patch: GlobalConfig,
  home = homedir(),
): Promise<{ path: string; merged: GlobalConfig }> {
  const current = await readGlobalConfig(home);
  const merged: GlobalConfig = { ...current, ...patch };
  const { path } = await writeGlobalConfig(merged, home);
  return { path, merged };
}
