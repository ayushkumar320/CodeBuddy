import { writeFile } from "node:fs/promises";
import { confirm, isCancel, log, note, password, select, spinner, text } from "@clack/prompts";
import { configPath, initConfigFile } from "../../core/config-file.js";
import { bootstrapDatabase } from "../../db/bootstrap.js";
import { createDatabaseClient, pingDatabase } from "../../db/client.js";
import { runMigrations } from "../../db/migrator.js";
import { installClaudeEntry } from "./claude-desktop.js";
import { postgresStatus, postgresUp } from "./postgres-docker.js";

export type WizardResult = {
  configPath: string;
  databaseReady: boolean;
  claudeInstalled: boolean;
};

function bail(): never {
  log.warn("Aborted.");
  process.exit(1);
}

function unwrap<T>(value: T | symbol): T {
  if (isCancel(value)) bail();
  return value as T;
}

export async function runInitWizard(): Promise<WizardResult> {
  note(
    "This wizard sets up your config file, checks Postgres, applies migrations, and (optionally) wires Claude Desktop.",
    "CodeBuddy init",
  );

  const providerType = unwrap(
    await select({
      message: "Which LLM provider should CodeBuddy use?",
      options: [
        { value: "huggingface", label: "Hugging Face (free, slower cold starts)" },
        { value: "groq", label: "Groq (fast LLM, embeddings still use Hugging Face)" },
      ],
      initialValue: "huggingface",
    }),
  ) as "huggingface" | "groq";

  const hfToken = unwrap(
    await password({
      message: "Hugging Face token (required for embeddings)",
      validate: (value) => (value && value.length > 0 ? undefined : "HF_TOKEN is required."),
    }),
  );

  let groqApiKey: string | undefined;
  if (providerType === "groq") {
    groqApiKey = unwrap(
      await password({
        message: "Groq API key",
        validate: (value) => (value && value.length > 0 ? undefined : "Groq key is required."),
      }),
    );
  }

  const databaseUrl = unwrap(
    await text({
      message: "Postgres URL",
      initialValue:
        process.env.DATABASE_URL ?? "postgres://codebuddy:codebuddy@localhost:5432/codebuddy",
      validate: (value) => (value && value.length > 0 ? undefined : "Postgres URL is required."),
    }),
  );

  const namespace = unwrap(
    await text({
      message: "Default namespace",
      initialValue: process.env.CODEBUDDY_NAMESPACE ?? "default",
      validate: (value) =>
        value && /^[a-zA-Z0-9_.:-]+$/.test(value) ? undefined : "Letters, digits, _ . : - only.",
    }),
  );

  const dbSpinner = spinner();
  dbSpinner.start("Checking Postgres connection");
  let connected = false;
  try {
    const client = createDatabaseClient({ postgresUrl: databaseUrl });
    connected = await pingDatabase(client);
    await client.close();
    dbSpinner.stop(connected ? "Postgres reachable." : "Postgres did not respond.");
  } catch (error) {
    dbSpinner.stop(`Postgres not reachable: ${(error as Error).message}`);
  }

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
      const result = await postgresUp();
      if (result.code === 0) {
        dockerSpinner.stop("Postgres container started.");
        const verify = createDatabaseClient({ postgresUrl: databaseUrl });
        try {
          connected = await pingDatabase(verify);
        } finally {
          await verify.close();
        }
      } else {
        dockerSpinner.stop(`docker compose failed: ${result.stderr || result.stdout}`);
      }
    }
  }

  if (connected) {
    const migrateSpinner = spinner();
    migrateSpinner.start("Applying migrations");
    try {
      const client = createDatabaseClient({ postgresUrl: databaseUrl });
      try {
        await bootstrapDatabase(client.sql);
        await runMigrations(client);
        migrateSpinner.stop("Migrations applied.");
      } finally {
        await client.close();
      }
    } catch (error) {
      migrateSpinner.stop(`Migration error: ${(error as Error).message}`);
    }
  } else {
    log.warn("Skipping migrations — Postgres is not reachable. Run `codebuddy migrate` later.");
  }

  const result = await initConfigFile();
  const config: Record<string, unknown> = {
    postgresUrl: databaseUrl,
    namespace,
    provider: { type: providerType, apiKey: providerType === "huggingface" ? hfToken : groqApiKey },
    tokenBudget: 4000,
  };
  await writeFile(result.path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  log.success(`Config written to ${result.path}`);

  const wireClaude = unwrap(
    await confirm({
      message: "Register this namespace with Claude Desktop now?",
      initialValue: true,
    }),
  );

  let claudeInstalled = false;
  if (wireClaude) {
    try {
      const install = await installClaudeEntry({
        namespace,
        hfToken,
        ...(groqApiKey ? { groqApiKey } : {}),
        databaseUrl,
      });
      claudeInstalled = true;
      log.success(
        `Added "${install.serverKey}" to ${install.path}. Restart Claude Desktop to activate.`,
      );
    } catch (error) {
      log.warn(`Claude Desktop install failed: ${(error as Error).message}`);
    }
  }

  if (process.platform === "darwin") {
    await postgresStatus().catch(() => undefined);
  }

  return {
    configPath: configPath(),
    databaseReady: connected,
    claudeInstalled,
  };
}
