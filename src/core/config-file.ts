import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { writeAtomic } from "./markdown-store-fs.js";
import type { CodeBuddyConfig } from "./types.js";

export const CONFIG_DIR = ".codebuddy";
export const CONFIG_FILE = "config.json";
export const POLICY_FILE = "policies.yaml";

const PROJECT_GITIGNORE = [
  "# CodeBuddy local-only files",
  "/config.json",
  "/cache/",
  "/memory/review/",
  "/memory/review-archive/",
  "/plans/.locks/",
  "/memory/.locks/",
  "",
  "# Keep these reviewable project artifacts shareable by default:",
  "#   /memory/facts/*.md",
  "#   /memory/summaries/*.md",
  "#   /plans/*.md",
  "# If your project memory is private, ignore /memory/ in the repo root .gitignore.",
  "",
].join("\n");

const DEFAULT_POLICY_FILE = [
  "rules:",
  "  - id: auth-sensitive",
  '    pattern: "src/auth/**"',
  '    message: "Auth changes need careful review."',
  "    weight: 70",
  "",
].join("\n");

/**
 * Plan policy controls how strongly CodeBuddy nudges agents toward writing
 * a plan before substantive work:
 *   - off:      plans are never suggested or required.
 *   - suggest:  agents are reminded to plan, but small tasks stay lightweight (default).
 *   - required: agents should refuse substantive changes without an active plan.
 */
export const PLAN_POLICIES = ["off", "suggest", "required"] as const;
export type PlanPolicy = (typeof PLAN_POLICIES)[number];

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
  plan: z
    .object({
      policy: z.enum(PLAN_POLICIES).default("suggest"),
    })
    .optional(),
  graphify: z
    .object({
      enabled: z.boolean(),
      graphPath: z.string().min(1).optional(),
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

export type ProjectScaffoldReport = {
  codebuddyDir: { path: string; exists: boolean; ok: boolean; warning?: string };
  memoryFactsDir: { path: string; exists: boolean; ok: boolean; warning?: string };
  memorySummariesDir: { path: string; exists: boolean; ok: boolean; warning?: string };
  plansDir: { path: string; exists: boolean; ok: boolean; warning?: string };
  gitignore: { path: string; exists: boolean; ok: boolean; warning?: string };
  policies: { path: string; exists: boolean; ok: boolean; warning?: string };
};

export function configPath(cwd = process.cwd()): string {
  return join(cwd, CONFIG_DIR, CONFIG_FILE);
}

export async function initProjectScaffold(cwd = process.cwd()): Promise<{
  codebuddyDir: string;
  gitignorePath: string;
  policyPath: string;
}> {
  const codebuddyDir = join(cwd, CONFIG_DIR);
  await mkdir(join(codebuddyDir, "memory", "facts"), { recursive: true, mode: 0o700 });
  await mkdir(join(codebuddyDir, "memory", "summaries"), { recursive: true, mode: 0o700 });
  await mkdir(join(codebuddyDir, "plans"), { recursive: true, mode: 0o700 });

  const gitignorePath = join(codebuddyDir, ".gitignore");
  try {
    await access(gitignorePath, constants.F_OK);
    let gitignore = await readFile(gitignorePath, "utf8");
    const lines = new Set(gitignore.split(/\r?\n/));
    const missing = ["/memory/review/", "/memory/review-archive/"].filter(
      (line) => !lines.has(line),
    );
    if (missing.length > 0) {
      gitignore = `${gitignore.trimEnd()}\n${missing.join("\n")}\n`;
      await writeFile(gitignorePath, gitignore, { mode: 0o644 });
    }
  } catch {
    await writeFile(gitignorePath, PROJECT_GITIGNORE, { mode: 0o644 });
  }

  const policyPath = join(codebuddyDir, POLICY_FILE);
  try {
    await access(policyPath, constants.F_OK);
  } catch {
    await writeFile(policyPath, DEFAULT_POLICY_FILE, { mode: 0o644 });
  }

  return { codebuddyDir, gitignorePath, policyPath };
}

export async function initConfigFile(
  cwd = process.cwd(),
): Promise<{ path: string; created: boolean }> {
  const path = configPath(cwd);
  await initProjectScaffold(cwd);
  try {
    await access(path, constants.F_OK);
    await chmod(path, 0o600);
    return { path, created: false };
  } catch {
    const template: CodeBuddyFileConfig = {
      postgresUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/codebuddy",
      // Default to the folder name (sanitized) so a fresh scaffold agrees with
      // doctor's expected default instead of warning immediately after init.
      namespace: defaultNamespaceForCwd(cwd),
      provider: { type: "huggingface" },
      tokenBudget: 4000,
    };
    await writeFile(path, `${JSON.stringify(template, null, 2)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    return { path, created: true };
  }
}

/** Persist a complete project config without changing its private permissions. */
export async function writeConfigFile(
  config: CodeBuddyFileConfig,
  cwd = process.cwd(),
): Promise<{ path: string }> {
  const path = configPath(cwd);
  await initProjectScaffold(cwd);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return { path };
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

/**
 * The ONE namespace-resolution rule, shared by the DB/MCP runtime, every
 * file-based CLI command, and doctor. Precedence:
 *   1. CODEBUDDY_NAMESPACE env
 *   2. `.codebuddy/config.json` `namespace`
 *   3. the current folder name (sanitized) — matching what doctor reports as
 *      the expected default.
 */
export function sanitizeNamespace(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 128);
}

/** Folder-name fallback used when neither env nor config specify a namespace. */
export function defaultNamespaceForCwd(cwd = process.cwd()): string {
  return sanitizeNamespace(basename(cwd)) || "default";
}

export async function resolveNamespaceFrom(cwd = process.cwd()): Promise<string> {
  if (process.env.CODEBUDDY_NAMESPACE) return process.env.CODEBUDDY_NAMESPACE;
  const file = await readConfigFile(cwd);
  return file.namespace ?? defaultNamespaceForCwd(cwd);
}

export async function loadRuntimeConfig(cwd = process.cwd()): Promise<CodeBuddyConfig> {
  const projectRoot = process.env.CODEBUDDY_PROJECT_ROOT ?? cwd;
  const file = await readConfigFile(projectRoot);
  const postgresUrl = process.env.DATABASE_URL ?? file.postgresUrl;
  if (!postgresUrl) {
    throw new Error("DATABASE_URL or .codebuddy/config.json postgresUrl is required.");
  }
  const hfToken = process.env.HF_TOKEN ?? file.provider?.apiKey;
  return {
    postgresUrl,
    namespace:
      process.env.CODEBUDDY_NAMESPACE ?? file.namespace ?? defaultNamespaceForCwd(projectRoot),
    projectRoot,
    provider: {
      type: "huggingface",
      ...(hfToken ? { apiKey: hfToken } : {}),
    },
    ...(file.tokenBudget ? { tokenBudget: file.tokenBudget } : {}),
    ...(file.graphify ? { graphify: file.graphify } : {}),
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

export async function checkProjectScaffold(cwd = process.cwd()): Promise<ProjectScaffoldReport> {
  const codebuddyDir = join(cwd, CONFIG_DIR);
  const memoryFactsDir = join(codebuddyDir, "memory", "facts");
  const memorySummariesDir = join(codebuddyDir, "memory", "summaries");
  const plansDir = join(codebuddyDir, "plans");
  const gitignorePath = join(codebuddyDir, ".gitignore");
  const policyPath = join(codebuddyDir, POLICY_FILE);

  const [
    codebuddyDirExists,
    memoryFactsDirExists,
    memorySummariesDirExists,
    plansDirExists,
    gitignoreExists,
    policiesExist,
  ] = await Promise.all([
    pathExists(codebuddyDir),
    pathExists(memoryFactsDir),
    pathExists(memorySummariesDir),
    pathExists(plansDir),
    pathExists(gitignorePath),
    pathExists(policyPath),
  ]);

  return {
    codebuddyDir: {
      path: codebuddyDir,
      exists: codebuddyDirExists,
      ok: codebuddyDirExists,
      ...(codebuddyDirExists
        ? {}
        : { warning: "Run `codebuddy use` or `codebuddy init` to create the project scaffold." }),
    },
    memoryFactsDir: {
      path: memoryFactsDir,
      exists: memoryFactsDirExists,
      ok: memoryFactsDirExists,
      ...(memoryFactsDirExists ? {} : { warning: "Missing .codebuddy/memory/facts directory." }),
    },
    memorySummariesDir: {
      path: memorySummariesDir,
      exists: memorySummariesDirExists,
      ok: memorySummariesDirExists,
      ...(memorySummariesDirExists
        ? {}
        : { warning: "Missing .codebuddy/memory/summaries directory." }),
    },
    plansDir: {
      path: plansDir,
      exists: plansDirExists,
      ok: plansDirExists,
      ...(plansDirExists ? {} : { warning: "Missing .codebuddy/plans directory." }),
    },
    gitignore: {
      path: gitignorePath,
      exists: gitignoreExists,
      ok: gitignoreExists,
      ...(gitignoreExists ? {} : { warning: "Missing .codebuddy/.gitignore." }),
    },
    policies: {
      path: policyPath,
      exists: policiesExist,
      ok: policiesExist,
      ...(policiesExist
        ? {}
        : {
            warning:
              "Missing .codebuddy/policies.yaml. Run `codebuddy use` or `codebuddy init` to scaffold it.",
          }),
    },
  };
}

/** Read the plan policy, honoring CODEBUDDY_PLAN_POLICY then the config file. */
export async function loadPlanPolicy(cwd = process.cwd()): Promise<PlanPolicy> {
  const fromEnv = process.env.CODEBUDDY_PLAN_POLICY;
  if (fromEnv && (PLAN_POLICIES as readonly string[]).includes(fromEnv)) {
    return fromEnv as PlanPolicy;
  }
  const file = await readConfigFile(cwd);
  return file.plan?.policy ?? "suggest";
}

/** Persist the plan policy into `.codebuddy/config.json`, creating it if needed. */
export async function setPlanPolicy(policy: PlanPolicy, cwd = process.cwd()): Promise<void> {
  await initConfigFile(cwd);
  const path = configPath(cwd);
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  raw.plan = { ...(raw.plan as Record<string, unknown> | undefined), policy };
  // Atomic rewrite: this file holds the postgresUrl and provider apiKey.
  await writeAtomic(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    let redacted = value;
    // HF token literal anywhere in a string.
    const hf = process.env.HF_TOKEN;
    if (hf) redacted = redacted.split(hf).join("[REDACTED]");
    // Credentials embedded in connection URLs (postgres://user:pass@host…).
    // The password — not the username — is the secret.
    redacted = redacted.replace(
      /(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^/\s@]+(@)/gi,
      "$1[REDACTED]$2",
    );
    return redacted;
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
