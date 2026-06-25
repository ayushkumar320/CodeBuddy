import { basename } from "node:path";
import { confirm, isCancel, log, note, password, spinner, text } from "@clack/prompts";
import pc from "picocolors";
import { mergeGlobalConfig, readGlobalConfig } from "../../core/global-config.js";
import { bootstrapDatabase } from "../../db/bootstrap.js";
import { createDatabaseClient, pingDatabase } from "../../db/client.js";
import { runMigrations } from "../../db/migrator.js";
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
    note(
      `Project folder: ${pc.bold(process.cwd())}\nNamespace:      ${pc.bold(namespace)}`,
      "codebuddy use",
    );

    const stored = await readGlobalConfig();

    // ── Hugging Face token ──────────────────────────────────────────
    let hfToken: string;
    if (process.env.HF_TOKEN) {
      hfToken = process.env.HF_TOKEN;
      log.info("Using HF_TOKEN from environment.");
    } else if (stored.hfToken) {
      hfToken = stored.hfToken;
      log.info(`Reusing saved Hugging Face token (${pc.dim("~/.codebuddy/global.json")}).`);
    } else {
      hfToken = unwrap(
        await password({
          message: "Hugging Face token (saved once, reused for every project)",
          validate: (value) => (value && value.length > 0 ? undefined : "HF_TOKEN is required."),
        }),
      );
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

    if (!connected && databaseUrl === DEFAULT_DB_URL) {
      dbSpinner.stop("Postgres unreachable on the default local URL.");
      const startDocker = unwrap(
        await confirm({
          message: "Start the bundled Postgres container with Docker now?",
          initialValue: true,
        }),
      );
      if (startDocker) {
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
      }
    } else {
      dbSpinner.stop(connected ? "Postgres reachable." : "Postgres unreachable at this URL.");
      if (!connected) {
        log.warn(
          "This is not the bundled URL — start your Postgres manually or pass --postgres-url.",
        );
        bail();
      }
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
      hfToken,
      databaseUrl,
      installPath: process.argv[1] ?? undefined,
    });

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
        ``,
        `Next:`,
        `  1. Restart Claude Desktop and Codex.`,
        `  2. Ask Claude or Codex to "remember" or "recall" — it will use the ${pc.cyan(`codebuddy-${namespace}`)} tools automatically.`,
        ``,
        `Manage:`,
        `  codebuddy claude list           ${pc.dim("# see every project wired up")}`,
        `  codebuddy codex list            ${pc.dim("# see Codex entries")}`,
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
