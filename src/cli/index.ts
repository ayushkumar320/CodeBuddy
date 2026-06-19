#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { initConfigFile, loadRuntimeConfig, redactSecrets } from "../core/config-file.js";
import { createRuntime, inspectNamespace, listFactsPage, runDoctor } from "../core/operations.js";
import { startMcpServer } from "../mcp/server.js";

export function createCli(): Command {
  const program = new Command();

  program
    .name("codebuddy")
    .description("MCP memory server for multi-agent systems.")
    .version("0.0.0");

  program
    .command("init")
    .description("Create .codebuddy/config.json with safe permissions.")
    .action(async () => {
      await runSafely(async () => {
        const result = await initConfigFile();
        console.log(`${result.created ? "created" : "updated permissions"} ${result.path}`);
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
        if (!report.db.ok || !report.pgvector.ok || report.config.warning) process.exitCode = 1;
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
  console.log(`DB connectivity: ${report.db.ok ? ok : bad}`);
  if (report.db.error) console.log(`  ${report.db.error}`);
  console.log(`pgvector: ${report.pgvector.ok ? ok : bad}`);
  if (report.pgvector.error) console.log(`  ${report.pgvector.error}`);
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
    `config permissions: ${report.config.exists ? report.config.mode : "missing"} ${report.config.ok ? ok : pc.yellow("warn")}`,
  );
  if (report.config.warning) console.log(`  ${report.config.warning}`);
  for (const model of report.models) {
    console.log(`model ${model.id}: ${model.status}${model.error ? ` (${model.error})` : ""}`);
  }
}

createCli().parseAsync();
