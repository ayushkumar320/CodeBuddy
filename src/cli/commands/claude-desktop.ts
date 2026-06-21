import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ClaudeDesktopEntry = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type ClaudeDesktopConfig = {
  mcpServers?: Record<string, ClaudeDesktopEntry>;
};

export function claudeDesktopConfigPath(home = process.env.HOME ?? ""): string {
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? home, "Claude", "claude_desktop_config.json");
  }
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

export async function readClaudeConfig(path: string): Promise<ClaudeDesktopConfig> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(await readFile(path, "utf8")) as ClaudeDesktopConfig;
  } catch (error) {
    throw new Error(
      `Failed to parse Claude Desktop config at ${path}: ${(error as Error).message}`,
    );
  }
}

export async function writeClaudeConfig(path: string, config: ClaudeDesktopConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/**
 * Resolve the absolute path to this codebuddy install's CLI entrypoint.
 *
 * Has to cope with three layouts:
 *   - dev:           `tsx src/cli/index.ts`           — argv[1] is the .ts file
 *   - built locally: `node dist/cli/index.js serve`   — argv[1] is dist/cli/index.js
 *   - npm bin:       `/usr/local/bin/codebuddy ...`   — argv[1] is the resolved bin
 *
 * `process.argv[1]` is the file Node was invoked with, which IS the CLI entry
 * in every supported case. We use it as the source of truth. import.meta.url
 * is unreliable here because tsup bundles src/cli/* into a single dist file,
 * so the source-relative path math (`..`) lands on the SDK barrel
 * (dist/index.js) instead of the CLI (dist/cli/index.js).
 */
export function resolveCliEntrypoint(): string {
  const fromArgv = process.argv[1];
  if (fromArgv && existsSync(fromArgv)) return fromArgv;

  // Fallback for the unlikely case where argv[1] is missing (eval'd, embedded
  // host, etc): walk the source layout.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "index.js"), // bundled: here = dist/cli/
    resolve(here, "..", "cli", "index.js"), // source: here = src/cli/commands/
    resolve(here, "..", "index.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Last resort — return argv[1] even if it doesn't exist, so the error
  // surfaces with the real path the caller saw rather than a stale guess.
  return fromArgv ?? candidates[0] ?? "";
}

export type InstallEntryOptions = {
  namespace: string;
  hfToken?: string;
  groqApiKey?: string;
  databaseUrl?: string;
  serverName?: string;
};

export function buildEntry(options: InstallEntryOptions): ClaudeDesktopEntry {
  const env: Record<string, string> = {
    CODEBUDDY_NAMESPACE: options.namespace,
  };
  if (options.hfToken) env.HF_TOKEN = options.hfToken;
  if (options.groqApiKey) env.GROQ_API_KEY = options.groqApiKey;
  if (options.databaseUrl) env.DATABASE_URL = options.databaseUrl;
  return {
    command: "node",
    args: [resolveCliEntrypoint(), "serve"],
    env,
  };
}

export type InstallResult = {
  path: string;
  serverKey: string;
  created: boolean;
};

export async function installClaudeEntry(options: InstallEntryOptions): Promise<InstallResult> {
  const path = claudeDesktopConfigPath();
  const config = await readClaudeConfig(path);
  config.mcpServers ??= {};
  const serverKey = options.serverName ?? `codebuddy-${options.namespace}`;
  const existed = config.mcpServers[serverKey] !== undefined;
  config.mcpServers[serverKey] = buildEntry(options);
  await writeClaudeConfig(path, config);
  return { path, serverKey, created: !existed };
}

export async function removeClaudeEntry(
  serverKey: string,
): Promise<{ removed: boolean; path: string }> {
  const path = claudeDesktopConfigPath();
  const config = await readClaudeConfig(path);
  if (!config.mcpServers || !(serverKey in config.mcpServers)) {
    return { removed: false, path };
  }
  delete config.mcpServers[serverKey];
  await writeClaudeConfig(path, config);
  return { removed: true, path };
}

export async function listClaudeEntries(): Promise<{
  path: string;
  entries: Array<{ key: string; namespace: string | null; databaseUrl: string | null }>;
}> {
  const path = claudeDesktopConfigPath();
  const config = await readClaudeConfig(path);
  const entries = Object.entries(config.mcpServers ?? {})
    .filter(([key]) => key === "codebuddy" || key.startsWith("codebuddy-"))
    .map(([key, entry]) => ({
      key,
      namespace: entry.env?.CODEBUDDY_NAMESPACE ?? null,
      databaseUrl: entry.env?.DATABASE_URL ?? null,
    }));
  return { path, entries };
}
