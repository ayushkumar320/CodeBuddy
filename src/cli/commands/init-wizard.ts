import { writeFile } from "node:fs/promises";
import { confirm, isCancel, log, note, password, spinner, text } from "@clack/prompts";
import { configPath, initConfigFile } from "../../core/config-file.js";
import { bootstrapDatabase } from "../../db/bootstrap.js";
import { createDatabaseClient, pingDatabase } from "../../db/client.js";
import { runMigrations } from "../../db/migrator.js";
import { installClaudeEntry } from "./claude-desktop.js";
import { postgresUp } from "./postgres-docker.js";

export type WizardResult = {
  configPath: string;
  databaseReady: boolean;
  claudeInstalled: boolean;
};

function bail(): never {
  log.warn("Aborted. No config was written.");
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

export async function runInitWizard(): Promise<WizardResult> {
  // Trap Ctrl-C cleanly so partial writes don't leave the user wedged.
  const sigintHandler = () => bail();
  process.on("SIGINT", sigintHandler);

  try {
    note(
      "Sets up your config file, checks Postgres, applies migrations, and (optionally) wires Claude Desktop.",
      "CodeBuddy init",
    );

    // ── Hugging Face token (always required — embeddings use HF) ────
    const hfToken = unwrap(
      await password({
        message: "Hugging Face token (required for embeddings)",
        validate: (value) => (value && value.length > 0 ? undefined : "HF_TOKEN is required."),
      }),
    );

    // ── Postgres URL ────────────────────────────────────────────────
    const databaseUrl = unwrap(
      await text({
        message: "Postgres URL",
        initialValue:
          process.env.DATABASE_URL ?? "postgres://codebuddy:codebuddy@localhost:5432/codebuddy",
        validate: (value) =>
          value && value.length > 0 ? undefined : "Postgres URL is required.",
      }),
    );

    // ── Namespace ───────────────────────────────────────────────────
    const namespace = unwrap(
      await text({
        message: "Default namespace",
        initialValue: process.env.CODEBUDDY_NAMESPACE ?? "default",
        validate: (value) =>
          value && /^[a-zA-Z0-9_.:-]+$/.test(value)
            ? undefined
            : "Letters, digits, _ . : - only.",
      }),
    );

    // ── Probe Postgres ──────────────────────────────────────────────
    const dbSpinner = spinner();
    dbSpinner.start("Checking Postgres connection");
    let connected = await pingOnce(databaseUrl);
    dbSpinner.stop(connected ? "Postgres reachable." : "Postgres did not respond.");

    if (!connected) {
      const startDocker = unwrap(
        await confirm({
          message: "Start the bundled Postgres container with docker compose?",
          initialValue: true,
        }),
      );
      if (startDocker) {
        const dockerSpinner = spinner();
        dockerSpinner.start("docker compose up -d");
        try {
          const result = await postgresUp();
          if (result.code === 0) {
            dockerSpinner.stop("Postgres container started.");
            // Give Postgres a few seconds to accept connections.
            for (let attempt = 0; attempt < 10 && !connected; attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 500));
              connected = await pingOnce(databaseUrl);
            }
            if (!connected) {
              log.warn("Container started but did not accept connections in time.");
            }
          } else {
            dockerSpinner.stop(`docker compose failed: ${result.stderr || result.stdout}`);
          }
        } catch (error) {
          dockerSpinner.stop(`docker compose failed: ${(error as Error).message}`);
        }
      }
    }

    // ── Migrations (only if DB is reachable) ────────────────────────
    if (connected) {
      const migrateSpinner = spinner();
      migrateSpinner.start("Enabling pgvector and applying migrations");
      const client = createDatabaseClient({ postgresUrl: databaseUrl });
      try {
        await bootstrapDatabase(client.sql);
        await runMigrations(client);
        migrateSpinner.stop("Migrations applied.");
      } catch (error) {
        migrateSpinner.stop(`Migration error: ${(error as Error).message}`);
      } finally {
        await client.close().catch(() => undefined);
      }
    } else {
      log.warn("Skipping migrations — Postgres is not reachable. Run `codebuddy migrate` later.");
    }

    // ── Write config (last so failures above don't leave a half-config) ──
    const initialised = await initConfigFile();
    const fileConfig = {
      postgresUrl: databaseUrl,
      namespace,
      provider: { type: "huggingface" as const, apiKey: hfToken },
      tokenBudget: 4000,
    };
    await writeFile(initialised.path, `${JSON.stringify(fileConfig, null, 2)}\n`, {
      mode: 0o600,
    });
    log.success(`Config written to ${initialised.path}`);

    // ── Claude Desktop registration (optional) ──────────────────────
    let claudeInstalled = false;
    const wireClaude = unwrap(
      await confirm({
        message: "Register this namespace with Claude Desktop now?",
        initialValue: true,
      }),
    );
    if (wireClaude) {
      try {
        const install = await installClaudeEntry({
          namespace,
          hfToken,
          databaseUrl,
        });
        claudeInstalled = true;
        log.success(
          `Added "${install.serverKey}" to ${install.path}. Restart Claude Desktop (⌘Q) to activate.`,
        );
      } catch (error) {
        log.warn(`Claude Desktop install failed: ${(error as Error).message}`);
      }
    }

    return {
      configPath: configPath(),
      databaseReady: connected,
      claudeInstalled,
    };
  } finally {
    process.off("SIGINT", sigintHandler);
  }
}
