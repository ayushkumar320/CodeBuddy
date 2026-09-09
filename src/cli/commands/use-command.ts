import { basename } from "node:path";
import { confirm, isCancel, log, note, password, spinner, text } from "@clack/prompts";
import pc from "picocolors";
import { initProjectScaffold, readConfigFile, writeConfigFile } from "../../core/config-file.js";
import { mergeGlobalConfig, readGlobalConfig } from "../../core/global-config.js";
import { bootstrapDatabase } from "../../db/bootstrap.js";
import { createDatabaseClient, pingDatabase } from "../../db/client.js";
import { runMigrations } from "../../db/migrator.js";
import { setupGraphify } from "../../integrations/graphify.js";
import { writeProjectMcpConfig } from "../../integrations/project-mcp.js";
import { installWorkflowRules } from "../../templates/install.js";
import { installClaudeEntry } from "./claude-desktop.js";
import { installCodexEntry } from "./codex.js";
import {
  isDockerDaemonRunning,
  tryStartDockerDesktop,
  waitForDockerDaemon,
} from "./docker-autostart.js";
import { postgresUp } from "./postgres-docker.js";

export type UseCommandOptions = {
  namespace?: string;
  postgresUrl?: string;
  skipClaude?: boolean;
  skipCodex?: boolean;
  graphify?: boolean;
  useDocker?: boolean;
};

function bail(): never {
  log.warn("Aborted.");
  process.exit(1);
}

function unwrap<T>(value: T | symbol): T {
  if (isCancel(value)) bail();
  return value as T;
}

async function pingOnce(databaseUrl: string): Promise<boolean> {
  const client = createDatabaseClient({ postgresUrl: databaseUrl });
  try {
    return await pingDatabase(client);
  } catch {
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function sanitizeNamespace(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 128) || "default";
}

const DEFAULT_DB_URL = "postgres://codebuddy:codebuddy@localhost:5432/codebuddy";

/**
 * One-command setup for a project folder. Reuses any HF token + Postgres URL
 * the user has already saved in ~/.codebuddy/global.json; prompts only for
 * what is genuinely missing. Auto-starts Docker Desktop if needed, brings up
 * the bundled Postgres container, applies migrations, and (unless suppressed)
 * registers per-folder Claude Desktop and Codex entries.
 */
export async function runUseCommand(options: UseCommandOptions = {}): Promise<void> {
  const sigintHandler = () => bail();
  process.on("SIGINT", sigintHandler);

  try {
    const folderName = basename(process.cwd());
    const namespace = sanitizeNamespace(options.namespace ?? folderName);
    await initProjectScaffold();
    const graphifyEnabled =
      options.graphify ??
      unwrap(
        await confirm({
          message: "Set up Graphify for richer architecture context?",
          initialValue: true,
        }),
      );
    note(
      `Project folder: ${pc.bold(process.cwd())}\nNamespace:      ${pc.bold(namespace)}`,
      "codebuddy use",
    );

    const stored = await readGlobalConfig();

    // ── Hugging Face token ──────────────────────────────────────────
    let hfToken: string | undefined;
    if (process.env.HF_TOKEN) {
      hfToken = process.env.HF_TOKEN;
      log.info("Using HF_TOKEN from environment.");
    } else if (stored.hfToken) {
      hfToken = stored.hfToken;
      log.info(`Reusing saved Hugging Face token (${pc.dim("~/.codebuddy/global.json")}).`);
    } else {
      hfToken = unwrap(
        await password({
          message: "Hugging Face token (optional; press Enter for local-only mode)",
        }),
      );
      if (!hfToken)
        log.info("No Hugging Face token supplied; local file context remains available.");
    }

    // ── Postgres URL ────────────────────────────────────────────────
    const initialUrl =
      options.postgresUrl ?? process.env.DATABASE_URL ?? stored.databaseUrl ?? DEFAULT_DB_URL;
    const databaseUrl = unwrap(
      await text({
        message: "Postgres URL (press Enter to accept)",
        initialValue: initialUrl,
        validate: (value) => (value && value.length > 0 ? undefined : "Postgres URL is required."),
      }),
    );

    // ── Make sure Postgres is reachable; spin Docker up if not ──────
    const dbSpinner = spinner();
    dbSpinner.start("Checking Postgres");
    let connected = await pingOnce(databaseUrl);
    if (connected) dbSpinner.stop("Local Postgres reachable.");

    if (!connected && databaseUrl === DEFAULT_DB_URL) {
      dbSpinner.stop("Postgres unreachable on the default local URL.");
    }

    const shouldUseDocker =
      !connected &&
      databaseUrl === DEFAULT_DB_URL &&
      (options.useDocker ??
        unwrap(
          await confirm({
            message: "Postgres is unavailable. Start the bundled Docker database now?",
            initialValue: true,
          }),
        ));

    if (shouldUseDocker) {
      if (!(await isDockerDaemonRunning())) {
        const dockerSpinner = spinner();
        dockerSpinner.start("Starting Docker Desktop");
        await tryStartDockerDesktop();
        const ready = await waitForDockerDaemon(60_000);
        if (!ready) {
          dockerSpinner.stop("Docker daemon did not start in 60s. Aborting.");
          bail();
        }
        dockerSpinner.stop("Docker daemon is up.");
      }
      const composeSpinner = spinner();
      composeSpinner.start("docker compose up -d");
      try {
        const result = await postgresUp();
        if (result.code === 0) {
          composeSpinner.stop("Postgres container started.");
          for (let attempt = 0; attempt < 12 && !connected; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            connected = await pingOnce(databaseUrl);
          }
          if (!connected) {
            log.warn("Container running but Postgres did not accept connections in time.");
          }
        } else {
          composeSpinner.stop(`docker compose failed: ${result.stderr || result.stdout}`);
        }
      } catch (error) {
        composeSpinner.stop(`docker compose failed: ${(error as Error).message}`);
      }
    } else if (!connected) {
      dbSpinner.stop(connected ? "Postgres reachable." : "Postgres unreachable at this URL.");
      log.warn(
        "Local Postgres is required. Start it, set DATABASE_URL, pass --postgres-url, or allow the bundled Docker database.",
      );
      bail();
    }

    if (!connected) bail();

    // ── pgvector + migrations ───────────────────────────────────────
    const migrateSpinner = spinner();
    migrateSpinner.start("Enabling pgvector + applying migrations");
    {
      const client = createDatabaseClient({ postgresUrl: databaseUrl });
      try {
        await bootstrapDatabase(client.sql);
        await runMigrations(client);
        migrateSpinner.stop("Database ready.");
      } catch (error) {
        migrateSpinner.stop(`Migration error: ${(error as Error).message}`);
        bail();
      } finally {
        await client.close().catch(() => undefined);
      }
    }

    // ── Persist defaults so the next project is even faster ─────────
    await mergeGlobalConfig({
      ...(hfToken ? { hfToken } : {}),
      databaseUrl,
      installPath: process.argv[1] ?? undefined,
    });

    const existingConfig = await readConfigFile();
    const graphifySetup = graphifyEnabled
      ? await setupGraphify({ repositoryRoot: process.cwd() })
      : null;
    const graphifyConfigured = graphifySetup?.available ?? false;
    await writeConfigFile({
      ...existingConfig,
      postgresUrl: databaseUrl,
      namespace,
      provider: { type: "huggingface", ...(hfToken ? { apiKey: hfToken } : {}) },
      tokenBudget: existingConfig.tokenBudget ?? 4000,
      graphify: { enabled: graphifyConfigured, graphPath: "graphify-out/graph.json" },
    });

    const graphifyMessage =
      graphifySetup?.message ?? "Graphify disabled; CodeBuddy MCP remains available.";
    await writeProjectMcpConfig({
      repositoryRoot: process.cwd(),
      namespace,
      graphify: graphifyConfigured,
    });
    await installWorkflowRules({ client: "claude", projectRoot: process.cwd() });
    await installWorkflowRules({ client: "codex", projectRoot: process.cwd() });

    // ── Wire Claude Desktop unless suppressed ───────────────────────
    if (!options.skipClaude) {
      try {
        const install = await installClaudeEntry({
          namespace,
          projectRoot: process.cwd(),
          hfToken,
          databaseUrl,
        });
        log.success(
          `Registered ${pc.bold(install.serverKey)} in Claude Desktop. Restart with ⌘Q to activate.`,
        );
      } catch (error) {
        log.warn(`Claude Desktop registration skipped: ${(error as Error).message}`);
      }
    }

    // ── Wire Codex unless suppressed ────────────────────────────────
    if (!options.skipCodex) {
      try {
        const install = await installCodexEntry({
          namespace,
          projectRoot: process.cwd(),
          hfToken,
          databaseUrl,
        });
        log.success(
          `Registered ${pc.bold(install.serverKey)} in Codex. Restart Codex to activate.`,
        );
      } catch (error) {
        log.warn(`Codex registration skipped: ${(error as Error).message}`);
      }
    }

    note(
      [
        `${pc.green("✓")} CodeBuddy is ready for ${pc.bold(folderName)}.`,
        `${pc.green("✓")} Scaffolded ${pc.cyan(".codebuddy/policies.yaml")} for project-specific guardrails.`,
        `${pc.green("✓")} ${graphifyMessage}`,
        `${pc.green("✓")} Added agent workflow instructions to ${pc.cyan("CLAUDE.md")} and ${pc.cyan("AGENTS.md")}.`,
        ``,
        `Next:`,
        `  1. Restart Claude Desktop and Codex.`,
        `  2. Ask Claude or Codex to use the ${pc.cyan("context_pack")} tool for each coding task.`,
        `  3. If Graphify is enabled, run ${pc.cyan("/graphify .")} once in your agent to build the local graph.`,
        `  3. Run ${pc.cyan("codebuddy doctor")} or ${pc.cyan("codebuddy db doctor")} if you want a full health check.`,
        ``,
        `Manage:`,
        `  codebuddy claude list           ${pc.dim("# see every project wired up")}`,
        `  codebuddy codex list            ${pc.dim("# see Codex entries")}`,
        `  codebuddy db test               ${pc.dim("# quick Postgres connectivity check")}`,
        `  codebuddy claude remove codebuddy-${namespace}`,
        `  codebuddy codex remove codebuddy-${namespace}`,
        `  codebuddy postgres down         ${pc.dim("# stop the DB (data preserved)")}`,
      ].join("\n"),
      "Done",
    );
  } finally {
    process.off("SIGINT", sigintHandler);
  }
}
