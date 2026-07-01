#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { initConfigFile, loadRuntimeConfig, redactSecrets } from "../core/config-file.js";
import { MemoryFileStore } from "../core/memory-file-store.js";
import { migrateMemoryToFiles } from "../core/migrate-to-files.js";
import { createRuntime, inspectNamespace, listFactsPage, runDoctor } from "../core/operations.js";
import { bootstrapDatabase } from "../db/bootstrap.js";
import { createDatabaseClient } from "../db/client.js";
import { runMigrations } from "../db/migrator.js";
import { startMcpServer } from "../mcp/server.js";
import {
  installClaudeEntry,
  listClaudeEntries,
  removeClaudeEntry,
} from "./commands/claude-desktop.js";
import { installCodexEntry, listCodexEntries, removeCodexEntry } from "./commands/codex.js";
import { registerContextCommands } from "./commands/context.js";
import { runInitWizard } from "./commands/init-wizard.js";
import { registerMapCommands } from "./commands/map.js";
import { registerPlanCommands } from "./commands/plan.js";
import { postgresDown, postgresStatus, postgresUp } from "./commands/postgres-docker.js";
import { registerRiskCommands } from "./commands/risk.js";
import { runUseCommand } from "./commands/use-command.js";

export function createCli(): Command {
  const program = new Command();

  program
    .name("codebuddy")
    .description("MCP memory server for multi-agent systems.")
    .version("0.0.0");

  program
    .command("use")
    .description(
      "One-command setup for the current project folder. Reuses saved HF token + DB URL, auto-starts Docker, runs migrations, and wires Claude Desktop.",
    )
    .argument("[namespace]", "Override the namespace (defaults to current folder name).")
    .option("--postgres-url <url>", "Postgres URL to use for this project.")
    .option("--skip-claude", "Do not register with Claude Desktop.")
    .option("--skip-codex", "Do not register with Codex.")
    .action(
      async (
        namespace: string | undefined,
        opts: { postgresUrl?: string; skipClaude?: boolean; skipCodex?: boolean },
      ) => {
        await runSafely(async () => {
          await runUseCommand({
            ...(namespace !== undefined ? { namespace } : {}),
            ...(opts.postgresUrl !== undefined ? { postgresUrl: opts.postgresUrl } : {}),
            ...(opts.skipClaude !== undefined ? { skipClaude: opts.skipClaude } : {}),
            ...(opts.skipCodex !== undefined ? { skipCodex: opts.skipCodex } : {}),
          });
        });
      },
    );

  program
    .command("init")
    .description("Interactive setup: config file, Postgres, migrations, Claude Desktop.")
    .option("--non-interactive", "Skip the wizard; just create .codebuddy/config.json.")
    .action(async (opts: { nonInteractive?: boolean }) => {
      await runSafely(async () => {
        if (opts.nonInteractive || !process.stdin.isTTY) {
          const result = await initConfigFile();
          console.log(`${result.created ? "created" : "updated permissions"} ${result.path}`);
          return;
        }
        await runInitWizard();
      });
    });

  const migrate = program
    .command("migrate")
    .description("Apply pending database migrations.")
    .action(async () => {
      await runSafely(async () => {
        const config = await loadRuntimeConfig();
        const client = createDatabaseClient({ postgresUrl: config.postgresUrl });
        try {
          await bootstrapDatabase(client.sql);
          await runMigrations(client);
          console.log("migrations applied");
        } finally {
          await client.close();
        }
      });
    });
  migrate
    .command("to-files")
    .description("Preview or write existing facts and summaries as Markdown files.")
    .option("--write", "Write files. Without this flag the command is a dry run.")
    .action(async (opts: { write?: boolean }) => {
      await withRuntime(async (runtime) => {
        const config = await loadRuntimeConfig();
        const result = await migrateMemoryToFiles({
          repository: runtime.repository,
          store: new MemoryFileStore(config.projectRoot ?? process.cwd()),
          namespace: config.namespace,
          write: opts.write ?? false,
        });
        console.log(JSON.stringify(result, null, 2));
      });
    });

  program
    .command("reindex")
    .description("Rebuild fact and summary records from Markdown files.")
    .option("--full", "Scan every Markdown memory file.")
    .action(async (_opts: { full?: boolean }) => {
      await withRuntime(async (runtime) => {
        console.log(JSON.stringify(await runtime.memory.reindexMemory(), null, 2));
      });
    });

  const postgres = program
    .command("postgres")
    .description("Manage the bundled Postgres container.");
  postgres
    .command("up")
    .description("Start the bundled Postgres container (docker compose up -d).")
    .action(async () => {
      await runSafely(async () => {
        const result = await postgresUp();
        process.stdout.write(result.stdout);
        if (result.code !== 0) {
          process.stderr.write(result.stderr);
          process.exitCode = result.code;
        }
      });
    });

  const db = program.command("db").description("Check database connectivity and setup health.");
  db.command("doctor")
    .description("Check Postgres reachability, pgvector, and namespace assumptions.")
    .action(async () => {
      await runSafely(async () => {
        const report = await runDoctor({ skipModelCheck: true });
        printDbDoctor(report);
        if (!report.db.ok || !report.pgvector.ok || !report.namespace.ok) process.exitCode = 1;
      });
    });
  db.command("test")
    .description("Run a simple database connectivity test.")
    .action(async () => {
      await runSafely(async () => {
        const report = await runDoctor({ skipModelCheck: true });
        if (!report.db.ok) {
          console.log("database test: fail");
          if (report.db.error) console.log(`  ${report.db.error}`);
          process.exitCode = 1;
          return;
        }
        console.log("database test: ok");
      });
    });
  postgres
    .command("down")
    .description("Stop the bundled Postgres container (data volume preserved).")
    .action(async () => {
      await runSafely(async () => {
        const result = await postgresDown();
        process.stdout.write(result.stdout);
        if (result.code !== 0) {
          process.stderr.write(result.stderr);
          process.exitCode = result.code;
        }
      });
    });
  postgres
    .command("status")
    .description("docker compose ps for the bundled Postgres container.")
    .action(async () => {
      await runSafely(async () => {
        const result = await postgresStatus();
        process.stdout.write(result.stdout);
        if (result.code !== 0) {
          process.stderr.write(result.stderr);
          process.exitCode = result.code;
        }
      });
    });

  const claude = program
    .command("claude")
    .description("Register CodeBuddy as an MCP server in Claude Desktop.");
  claude
    .command("install")
    .option("--namespace <name>", "Namespace for this Claude Desktop entry.")
    .option("--server-name <name>", "Override the server key. Defaults to codebuddy-<namespace>.")
    .description("Add or update a codebuddy MCP entry in Claude Desktop's config.")
    .action(async (opts: { namespace?: string; serverName?: string }) => {
      await runSafely(async () => {
        const config = await loadRuntimeConfig();
        const namespace = opts.namespace ?? config.namespace ?? "default";
        const install = await installClaudeEntry({
          namespace,
          projectRoot: process.cwd(),
          ...(config.provider.apiKey ? { hfToken: config.provider.apiKey } : {}),
          ...(process.env.GROQ_API_KEY ? { groqApiKey: process.env.GROQ_API_KEY } : {}),
          databaseUrl: config.postgresUrl,
          ...(opts.serverName ? { serverName: opts.serverName } : {}),
        });
        console.log(
          `${install.created ? "added" : "updated"} ${install.serverKey} in ${install.path}`,
        );
        console.log("Restart Claude Desktop (⌘Q) to activate.");
      });
    });
  claude
    .command("list")
    .description("List codebuddy entries currently registered in Claude Desktop.")
    .action(async () => {
      await runSafely(async () => {
        const result = await listClaudeEntries();
        if (result.entries.length === 0) {
          console.log(`No codebuddy entries in ${result.path}.`);
          return;
        }
        console.log(`Claude Desktop config: ${result.path}`);
        for (const entry of result.entries) {
          console.log(
            `  ${entry.key}  namespace=${entry.namespace ?? "?"}  db=${entry.databaseUrl ?? "?"}`,
          );
        }
      });
    });
  claude
    .command("remove")
    .argument("<serverKey>", "e.g. codebuddy-work")
    .description("Remove a codebuddy entry from Claude Desktop's config.")
    .action(async (serverKey: string) => {
      await runSafely(async () => {
        const result = await removeClaudeEntry(serverKey);
        if (result.removed) {
          console.log(`removed ${serverKey} from ${result.path}`);
          console.log("Restart Claude Desktop (⌘Q) for the change to take effect.");
        } else {
          console.log(`no entry "${serverKey}" found in ${result.path}`);
          process.exitCode = 1;
        }
      });
    });

  const codex = program
    .command("codex")
    .description("Register CodeBuddy as an MCP server in Codex.");
  codex
    .command("install")
    .option("--namespace <name>", "Namespace for this Codex entry.")
    .option("--server-name <name>", "Override the server key. Defaults to codebuddy-<namespace>.")
    .description("Add or update a codebuddy MCP entry in ~/.codex/config.toml.")
    .action(async (opts: { namespace?: string; serverName?: string }) => {
      await runSafely(async () => {
        const config = await loadRuntimeConfig();
        const namespace = opts.namespace ?? config.namespace ?? "default";
        const install = await installCodexEntry({
          namespace,
          projectRoot: process.cwd(),
          ...(config.provider.apiKey ? { hfToken: config.provider.apiKey } : {}),
          databaseUrl: config.postgresUrl,
          ...(opts.serverName ? { serverName: opts.serverName } : {}),
        });
        console.log(
          `${install.created ? "added" : "updated"} ${install.serverKey} in ${install.path}`,
        );
        console.log("Restart Codex to activate.");
      });
    });
  codex
    .command("list")
    .description("List codebuddy entries currently registered in Codex.")
    .action(async () => {
      await runSafely(async () => {
        const result = await listCodexEntries();
        if (result.entries.length === 0) {
          console.log(`No codebuddy entries in ${result.path}.`);
          return;
        }
        console.log(`Codex config: ${result.path}`);
        for (const entry of result.entries) {
          console.log(
            `  ${entry.key}  namespace=${entry.namespace ?? "?"}  db=${entry.databaseUrl ?? "?"}`,
          );
        }
      });
    });
  codex
    .command("remove")
    .argument("<serverKey>", "e.g. codebuddy-work")
    .description("Remove a codebuddy entry from Codex config.")
    .action(async (serverKey: string) => {
      await runSafely(async () => {
        const result = await removeCodexEntry(serverKey);
        if (result.removed) {
          console.log(`removed ${serverKey} from ${result.path}`);
          console.log("Restart Codex for the change to take effect.");
        } else {
          console.log(`no entry "${serverKey}" found in ${result.path}`);
          process.exitCode = 1;
        }
      });
    });

  program
    .command("serve")
    .description("Start the CodeBuddy MCP stdio server.")
    .action(async () => runSafely(() => startMcpServer()));

  program
    .command("inspect")
    .argument("[namespace]")
    .description("Inspect namespaces or a namespace.")
    .action(async (namespace?: string) => {
      await withRuntime(async (runtime) => {
        console.log(JSON.stringify(await inspectNamespace(runtime.repository, namespace), null, 2));
      });
    });

  program
    .command("namespaces")
    .description("List namespaces.")
    .action(async () => {
      await withRuntime(async (runtime) => {
        console.log(
          JSON.stringify({ namespaces: await runtime.repository.listNamespaces() }, null, 2),
        );
      });
    });

  program
    .command("prune")
    .requiredOption("--older-than <duration>", "Duration such as 30d, 12h, or 60m.")
    .description("Delete memories older than a duration.")
    .action(async (opts: { olderThan: string }) => {
      await withRuntime(async (runtime) => {
        const cutoff = new Date(Date.now() - parseDuration(opts.olderThan));
        console.log(JSON.stringify(await runtime.repository.pruneBefore(cutoff), null, 2));
      });
    });

  program
    .command("export")
    .argument("<namespace>")
    .description("Export facts from a namespace as JSON.")
    .action(async (namespace: string) => {
      await withRuntime(async (runtime) => {
        const row = await runtime.repository.getNamespaceByName(namespace);
        if (!row) throw new Error(`Namespace ${namespace} does not exist.`);
        const facts = await runtime.repository.listFacts({ namespaceId: row.id, limit: 10_000 });
        console.log(JSON.stringify({ namespace, facts }, null, 2));
      });
    });

  program
    .command("stats")
    .description("Show CodeBuddy storage and usage stats.")
    .action(async () => {
      await withRuntime(async (runtime) => {
        console.log(JSON.stringify(await runtime.repository.getStats(), null, 2));
      });
    });

  program
    .command("doctor")
    .description("Check CodeBuddy environment health.")
    .option("--skip-model-check", "Do not call Hugging Face models.")
    .action(async (opts: { skipModelCheck?: boolean }) => {
      await runSafely(async () => {
        const report = await runDoctor({ skipModelCheck: opts.skipModelCheck ?? true });
        printDoctor(report);
        if (
          !report.db.ok ||
          !report.pgvector.ok ||
          report.config.warning ||
          !report.scaffold.policies.ok ||
          !report.scaffold.codebuddyDir.ok ||
          !report.namespace.ok
        ) {
          process.exitCode = 1;
        }
      });
    });

  program
    .command("list-facts")
    .option("--subject <subject>")
    .option("--limit <limit>", "Maximum facts to print.", Number)
    .option("--cursor <cursor>")
    .description("List facts from the configured namespace.")
    .action(async (opts: { subject?: string; limit?: number; cursor?: string }) => {
      await withRuntime(async (runtime) => {
        console.log(
          JSON.stringify(await listFactsPage(runtime.memory, runtime.repository, opts), null, 2),
        );
      });
    });

  registerPlanCommands(program, runSafely);
  registerRiskCommands(program, runSafely);
  registerMapCommands(program, runSafely);
  registerContextCommands(program, runSafely);

  return program;
}

async function withRuntime(
  fn: (runtime: Awaited<ReturnType<typeof createRuntime>>) => Promise<void>,
) {
  await runSafely(async () => {
    const runtime = await createRuntime(await loadRuntimeConfig());
    try {
      await fn(runtime);
    } finally {
      await runtime.close();
    }
  });
}

async function runSafely(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (error) {
    console.error(pc.red(String(redactSecrets((error as Error).message))));
    process.exitCode = 1;
  }
}

function parseDuration(value: string): number {
  const match = /^(\d+)([dhm])$/.exec(value);
  if (!match) throw new Error("--older-than must look like 30d, 12h, or 60m.");
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "d") return amount * 24 * 60 * 60 * 1000;
  if (unit === "h") return amount * 60 * 60 * 1000;
  return amount * 60 * 1000;
}

function printDoctor(report: Awaited<ReturnType<typeof runDoctor>>) {
  const ok = pc.green("ok");
  const bad = pc.red("fail");
  const warn = pc.yellow("warn");
  console.log(`scaffold root: ${report.scaffold.codebuddyDir.ok ? ok : bad}`);
  if (report.scaffold.codebuddyDir.warning)
    console.log(`  ${report.scaffold.codebuddyDir.warning}`);
  console.log(`policy scaffold: ${report.scaffold.policies.ok ? ok : bad}`);
  if (report.scaffold.policies.warning) console.log(`  ${report.scaffold.policies.warning}`);
  console.log(`DB connectivity: ${report.db.ok ? ok : bad}`);
  if (report.db.error) console.log(`  ${report.db.error}`);
  console.log(`pgvector: ${report.pgvector.ok ? ok : bad}`);
  if (report.pgvector.error) console.log(`  ${report.pgvector.error}`);
  console.log(`namespace: ${report.namespace.ok ? ok : warn}`);
  console.log(
    `  runtime=${report.namespace.runtime ?? "unset"} default=${report.namespace.expectedDefault}`,
  );
  if (report.namespace.warning) console.log(`  ${report.namespace.warning}`);
  console.log(
    `vectors: ${report.vectors.count} index=${report.vectors.index ?? "missing"} tuning=${report.vectors.needsTuning ? "recommended" : "not-needed"}`,
  );
  console.log(
    `recent calls: 60s=${report.usage.last60s} hour=${report.usage.lastHour} 24h=${report.usage.last24h}`,
  );
  console.log(`estimated daily cap remaining: ${report.usage.estimatedDailyCapRemaining}`);
  if (report.usage.warning80Percent)
    console.log(pc.yellow("usage warning: daily cap is over 80% used"));
  console.log(
    `config permissions: ${report.config.exists ? report.config.mode : "missing"} ${report.config.ok ? ok : warn}`,
  );
  if (report.config.warning) console.log(`  ${report.config.warning}`);
  for (const model of report.models) {
    console.log(`model ${model.id}: ${model.status}${model.error ? ` (${model.error})` : ""}`);
  }
}

function printDbDoctor(report: Awaited<ReturnType<typeof runDoctor>>) {
  const ok = pc.green("ok");
  const bad = pc.red("fail");
  const warn = pc.yellow("warn");
  console.log(`DB connectivity: ${report.db.ok ? ok : bad}`);
  if (report.db.postgresUrlSource) console.log(`  url source: ${report.db.postgresUrlSource}`);
  if (report.db.error) console.log(`  ${report.db.error}`);
  console.log(`pgvector: ${report.pgvector.ok ? ok : bad}`);
  if (report.pgvector.error) console.log(`  ${report.pgvector.error}`);
  console.log(`namespace: ${report.namespace.ok ? ok : warn}`);
  console.log(`  runtime=${report.namespace.runtime ?? "unset"}`);
  if (report.namespace.warning) console.log(`  ${report.namespace.warning}`);
}

createCli().parseAsync();
