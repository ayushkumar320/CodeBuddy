import type { Command } from "commander";
import pc from "picocolors";
import { buildArchitectureMap, neighbours, queryMap } from "../../map/indexer.js";

export function registerMapCommands(
  program: Command,
  runSafely: (fn: () => Promise<void>) => Promise<void>,
): void {
  const map = program.command("map").description("Query the lightweight architecture map.");

  map
    .command("build")
    .description("Scan the current repository and summarize the module graph.")
    .action(async () => {
      await runSafely(async () => {
        const graph = await buildArchitectureMap();
        console.log(
          JSON.stringify({ modules: graph.modules.length, edges: graph.edges.length }, null, 2),
        );
      });
    });

  map
    .command("deps")
    .argument("<path>", "Repo-relative module path.")
    .option("--json", "Print machine-readable JSON.")
    .description("List modules imported by a file.")
    .action(async (path: string, opts: { json?: boolean }) => {
      await runSafely(async () => {
        const graph = await buildArchitectureMap();
        const edges = queryMap(graph, { from: path });
        if (opts.json) {
          console.log(JSON.stringify({ edges }, null, 2));
          return;
        }
        if (edges.length === 0) {
          console.log(pc.dim("no dependencies found"));
          return;
        }
        for (const edge of edges) console.log(`${edge.from} -> ${edge.to}`);
      });
    });

  map
    .command("dependents")
    .argument("<path>", "Repo-relative module path.")
    .option("--json", "Print machine-readable JSON.")
    .description("List modules that import a file.")
    .action(async (path: string, opts: { json?: boolean }) => {
      await runSafely(async () => {
        const graph = await buildArchitectureMap();
        const result = neighbours(graph, path, "in");
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (result.edges.length === 0) {
          console.log(pc.dim("no dependents found"));
          return;
        }
        for (const edge of result.edges) console.log(`${edge.from} -> ${edge.to}`);
      });
    });
}
