import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildEntry, type ClaudeDesktopEntry } from "./claude-desktop.js";

export type CodexConfigEntry = ClaudeDesktopEntry;

export function codexConfigPath(home = homedir()): string {
  return join(home, ".codex", "config.toml");
}

export async function readCodexConfig(path: string): Promise<string> {
  if (!existsSync(path)) return "";
  return readFile(path, "utf8");
}

export async function writeCodexConfig(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

export type InstallCodexEntryOptions = {
  namespace: string;
  projectRoot?: string;
  hfToken?: string;
  databaseUrl?: string;
  serverName?: string;
};

export type InstallCodexResult = {
  path: string;
  serverKey: string;
  created: boolean;
};

export async function installCodexEntry(
  options: InstallCodexEntryOptions,
): Promise<InstallCodexResult> {
  const path = codexConfigPath();
  const serverKey = options.serverName ?? `codebuddy-${options.namespace}`;
  const current = await readCodexConfig(path);
  const existed = hasServerBlock(current, serverKey);
  const next = upsertServerBlock(current, serverKey, buildEntry(options));
  await writeCodexConfig(path, next);
  return { path, serverKey, created: !existed };
}

export async function removeCodexEntry(
  serverKey: string,
): Promise<{ removed: boolean; path: string }> {
  const path = codexConfigPath();
  const current = await readCodexConfig(path);
  const next = removeServerBlock(current, serverKey);
  const removed = next !== current;
  if (removed) await writeCodexConfig(path, next);
  return { removed, path };
}

export async function listCodexEntries(): Promise<{
  path: string;
  entries: Array<{ key: string; namespace: string | null; databaseUrl: string | null }>;
}> {
  const path = codexConfigPath();
  const config = await readCodexConfig(path);
  const entries = Array.from(config.matchAll(/^\[mcp_servers\."([^"]+)"\]\s*$/gm))
    .flatMap((match) => (match[1] ? [match[1]] : []))
    .filter((key) => key === "codebuddy" || key.startsWith("codebuddy-"))
    .map((key) => {
      const block = getServerBlock(config, key);
      return {
        key,
        namespace: readEnvValue(block, "CODEBUDDY_NAMESPACE"),
        databaseUrl: readEnvValue(block, "DATABASE_URL"),
      };
    });
  return { path, entries };
}

function upsertServerBlock(config: string, serverKey: string, entry: CodexConfigEntry): string {
  const trimmed = removeServerBlock(config, serverKey).trimEnd();
  const block = formatServerBlock(serverKey, entry);
  return `${trimmed}${trimmed ? "\n\n" : ""}${block}\n`;
}

function removeServerBlock(config: string, serverKey: string): string {
  const escaped = escapeRegExp(serverKey);
  const end = String.raw`(?![\s\S])`;
  const sectionPattern = String.raw`^\[mcp_servers\."${escaped}"\][\s\S]*?(?=^\[[^\]]+\]\s*$|${end})`;
  const envPattern = String.raw`^\[mcp_servers\."${escaped}"\.env\][\s\S]*?(?=^\[[^\]]+\]\s*$|${end})`;
  return config
    .replace(new RegExp(sectionPattern, "gm"), "")
    .replace(new RegExp(envPattern, "gm"), "");
}

function getServerBlock(config: string, serverKey: string): string {
  const escaped = escapeRegExp(serverKey);
  const end = String.raw`(?![\s\S])`;
  const pattern = String.raw`^\[mcp_servers\."${escaped}"\][\s\S]*?(?=^\[mcp_servers\."${escaped}"\.env\][\s\S]*?(?=^\[[^\]]+\]\s*$|${end})|^\[[^\]]+\]\s*$|${end})`;
  const server = config.match(new RegExp(pattern, "m"))?.[0] ?? "";
  const env =
    config.match(
      new RegExp(
        String.raw`^\[mcp_servers\."${escaped}"\.env\][\s\S]*?(?=^\[[^\]]+\]\s*$|${end})`,
        "m",
      ),
    )?.[0] ?? "";
  return `${server}\n${env}`;
}

function hasServerBlock(config: string, serverKey: string): boolean {
  return new RegExp(String.raw`^\[mcp_servers\."${escapeRegExp(serverKey)}"\]\s*$`, "m").test(
    config,
  );
}

function formatServerBlock(serverKey: string, entry: CodexConfigEntry): string {
  const lines = [
    `[mcp_servers.${tomlKey(serverKey)}]`,
    `command = ${tomlString(entry.command)}`,
    `args = ${tomlArray(entry.args)}`,
  ];
  if (entry.env && Object.keys(entry.env).length > 0) {
    lines.push("", `[mcp_servers.${tomlKey(serverKey)}.env]`);
    for (const [key, value] of Object.entries(entry.env).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      lines.push(`${key} = ${tomlString(value)}`);
    }
  }
  return lines.join("\n");
}

function readEnvValue(block: string, key: string): string | null {
  return block.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"]*)"`, "m"))?.[1] ?? null;
}

function tomlKey(key: string): string {
  return `"${key.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
