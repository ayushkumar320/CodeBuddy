import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateGraphifyGraph, graphifyGraphExists, setupGraphify } from "./graphify.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function rootWithGraph(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-graphify-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  return root;
}

async function writeGraph(path: string, nodes = 2, edges = 1): Promise<void> {
  await mkdir(join(path, "graphify-out"), { recursive: true });
  await writeFile(
    join(path, "graphify-out", "graph.json"),
    JSON.stringify({
      nodes: Array.from({ length: nodes }, (_, i) => ({ id: String(i) })),
      edges: Array.from({ length: edges }, () => ({ source: "0", target: "1" })),
    }),
  );
}

describe("setupGraphify", () => {
  it("detects Graphify and registers its assistant skill", async () => {
    const root = await rootWithGraph();
    const calls: string[] = [];
    const result = await setupGraphify({
      repositoryRoot: root,
      run: async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "graphify" && args[0] === "extract") {
          const stage = args[3];
          if (!stage) throw new Error("missing staging path");
          await mkdir(join(stage, "graphify-out"), { recursive: true });
          await writeFile(
            join(stage, "graphify-out", "graph.json"),
            JSON.stringify({ nodes: [{ id: "a" }], edges: [] }),
          );
        }
        return { stdout: "graphify 1.0.0", stderr: "" };
      },
    });

    expect(result.available).toBe(true);
    expect(result.installed).toBe(false);
    expect(result.generated).toBe(true);
    expect(calls[0]).toBe("graphify --version");
    expect(calls[1]).toBe("graphify install");
    expect(calls[2]).toMatch(
      new RegExp(`^graphify extract ${root} --out .+ --code-only --no-cluster$`),
    );
  });

  it("generates a first graph and creates the output directory", async () => {
    const root = await rootWithGraph();
    const calls: string[][] = [];
    const result = await generateGraphifyGraph({
      repositoryRoot: root,
      run: async (_command, args) => {
        calls.push(args);
        const stage = args[3];
        if (!stage) throw new Error("missing staging path");
        await writeGraph(stage);
        return { stdout: "", stderr: "" };
      },
    });
    expect(result.nodes).toBe(2);
    expect(await graphifyGraphExists(root)).toBe(true);
    expect(calls[0]?.slice(0, 2)).toEqual(["extract", root]);
  });

  it("self-ignores the generated graph directory without overwriting an existing .gitignore", async () => {
    const root = await rootWithGraph();
    const generate = () =>
      generateGraphifyGraph({
        repositoryRoot: root,
        run: async (_command, args) => {
          // Only the first call extracts into staging; the second takes the
          // in-place `update` path and needs no staged graph.
          if (args[0] === "extract" && args[3]) await writeGraph(args[3]);
          return { stdout: "", stderr: "" };
        },
      });

    await generate();
    expect(await readFile(join(root, "graphify-out", ".gitignore"), "utf8")).toContain("*");

    await writeFile(join(root, "graphify-out", ".gitignore"), "# mine\n");
    await generate();
    expect(await readFile(join(root, "graphify-out", ".gitignore"), "utf8")).toBe("# mine\n");
  });

  it("recovers from a missing or invalid graph without leaving invalid output", async () => {
    const root = await rootWithGraph();
    await mkdir(join(root, "graphify-out"), { recursive: true });
    await writeFile(join(root, "graphify-out", "graph.json"), "not json");
    await generateGraphifyGraph({
      repositoryRoot: root,
      run: async (_command, args) => {
        const stage = args[3];
        if (!stage) throw new Error("missing staging path");
        await writeGraph(stage);
        return { stdout: "", stderr: "" };
      },
    });
    expect(
      JSON.parse(await readFile(join(root, "graphify-out", "graph.json"), "utf8")).nodes,
    ).toHaveLength(2);
  });

  it("uses incremental Graphify update after repository changes and preserves valid output on failure", async () => {
    const root = await rootWithGraph();
    await writeGraph(root);
    let mode = "update";
    await generateGraphifyGraph({
      repositoryRoot: root,
      run: async (_command, args) => {
        expect(args[0]).toBe("update");
        if (mode === "fail") throw new Error("extractor failed");
        return { stdout: "", stderr: "" };
      },
    });
    mode = "fail";
    await expect(
      generateGraphifyGraph({
        repositoryRoot: root,
        run: async () => {
          throw new Error("extractor failed");
        },
      }),
    ).rejects.toThrow("previous graph was preserved");
    expect(await graphifyGraphExists(root)).toBe(true);
  });
});
