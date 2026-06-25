import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CodeBuddyConfig } from "./types.js";

export const CONFIG_DIR = ".codebuddy";
export const CONFIG_FILE = "config.json";

const fileSchema = z.object({
  postgresUrl: z.string().min(1).optional(),
  namespace: z.string().min(1).optional(),
  tokenBudget: z.number().int().positive().optional(),
  provider: z
    .object({
      type: z.literal("huggingface").default("huggingface"),
      apiKey: z.string().min(1).optional(),
    })
    .optional(),
});

export type CodeBuddyFileConfig = z.infer<typeof fileSchema>;

export type ConfigPermissionReport = {
  path: string;
  exists: boolean;
  mode: string | null;
  ok: boolean;
  warning?: string;
};

export function configPath(cwd = process.cwd()): string {
  return join(cwd, CONFIG_DIR, CONFIG_FILE);
}

export async function initConfigFile(
  cwd = process.cwd(),
): Promise<{ path: string; created: boolean }> {
  const path = configPath(cwd);
  await mkdir(join(cwd, CONFIG_DIR), { recursive: true, mode: 0o700 });
  try {
    await access(path, constants.F_OK);
    await chmod(path, 0o600);
    return { path, created: false };
  } catch {
    const template: CodeBuddyFileConfig = {
      postgresUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/codebuddy",
      namespace: "default",
      provider: { type: "huggingface" },
      tokenBudget: 4000,
    };
    await writeFile(path, `${JSON.stringify(template, null, 2)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    return { path, created: true };
  }
}

export async function readConfigFile(cwd = process.cwd()): Promise<CodeBuddyFileConfig> {
  const path = configPath(cwd);
  try {
    const raw = await readFile(path, "utf8");
    return fileSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function loadRuntimeConfig(cwd = process.cwd()): Promise<CodeBuddyConfig> {
  const file = await readConfigFile(cwd);
  const postgresUrl = process.env.DATABASE_URL ?? file.postgresUrl;
  if (!postgresUrl) {
    throw new Error("DATABASE_URL or .codebuddy/config.json postgresUrl is required.");
  }
  const hfToken = process.env.HF_TOKEN ?? file.provider?.apiKey;
  return {
    postgresUrl,
    namespace: process.env.CODEBUDDY_NAMESPACE ?? file.namespace ?? "default",
    projectRoot: process.env.CODEBUDDY_PROJECT_ROOT ?? cwd,
    provider: {
      type: "huggingface",
      ...(hfToken ? { apiKey: hfToken } : {}),
    },
    ...(file.tokenBudget ? { tokenBudget: file.tokenBudget } : {}),
  };
}

export async function checkConfigPermissions(cwd = process.cwd()): Promise<ConfigPermissionReport> {
  const path = configPath(cwd);
  try {
    const info = await stat(path);
    const modeNumber = info.mode & 0o777;
    const mode = modeNumber.toString(8).padStart(4, "0");
    const ok = modeNumber === 0o600;
    return {
      path,
      exists: true,
      mode,
      ok,
      ...(ok ? {} : { warning: ".codebuddy/config.json should be chmod 0600." }),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, exists: false, mode: null, ok: true };
    }
    throw error;
  }
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    const hf = process.env.HF_TOKEN;
    return hf ? value.split(hf).join("[REDACTED]") : value;
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      /token|apiKey|authorization|secret/i.test(key) ? "[REDACTED]" : redactSecrets(nested),
    ]),
  );
}
