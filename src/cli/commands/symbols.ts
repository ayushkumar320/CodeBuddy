import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { extractSymbolTable, supportsSymbols, symbolSignatures } from "../../indexer/symbols.js";
import { estimateTokens } from "../../savings/tokens.js";

/**
 * `codebuddy symbols <path>` inspects a file's symbol table — the basis for
 * symbol-level context (Roadmap N.3, shipped). File-based; no database.
 */
export function registerSymbolsCommand(
  program: Command,
  runSafely: (fn: () => Promise<void>) => Promise<void>,
): void {
  program
    .command("symbols")
    .argument("<path>", "Repo-relative or absolute path to a code file.")
    .option("--json", "Print machine-readable JSON.")
    .description("List a file's top-level symbols (functions, classes, types, exports).")
    .action(async (path: string, opts: { json?: boolean }) => {
      await runSafely(async () => {
        if (!supportsSymbols(path)) {
          console.log(pc.dim(`no symbol extraction for ${path} (unsupported language)`));
          return;
        }
        const content = await readFile(resolve(path), "utf8");
        const table = extractSymbolTable(content);

        if (opts.json) {
          console.log(JSON.stringify({ path, symbols: table }, null, 2));
          return;
        }

        if (table.length === 0) {
          console.log(pc.dim("no top-level symbols found"));
          return;
        }
        for (const symbol of table) {
          const badge = symbol.exported ? pc.green("export") : pc.dim("local ");
          console.log(
            `${badge} ${pc.cyan(symbol.kind.padEnd(9))} ${pc.bold(symbol.name)} ${pc.dim(`L${symbol.startLine}-${symbol.endLine}`)}`,
          );
        }
        const fileTokens = estimateTokens(content);
        const sigTokens = estimateTokens(symbolSignatures(table, table.length).join("\n"));
        const percent = fileTokens > 0 ? Math.round((1 - sigTokens / fileTokens) * 100) : 0;
        console.log(
          pc.dim(
            `\n${table.length} symbol(s) · signatures ~${sigTokens} tokens vs full file ~${fileTokens} (${percent}% smaller)`,
          ),
        );
      });
    });
}
