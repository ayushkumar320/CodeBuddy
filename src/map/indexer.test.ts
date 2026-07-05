import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildArchitectureMap, neighbours, queryMap } from "./indexer.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-map-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("buildArchitectureMap", () => {
  it("extracts relative TypeScript import edges", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "src", "core"), { recursive: true });
    await writeFile(
      join(root, "src", "index.ts"),
      [
        'import { helper } from "./core/helper";',
        'export { helper } from "./core/helper";',
        'await import("./core/lazy");',
      ].join("\n"),
    );
    await writeFile(join(root, "src", "core", "helper.ts"), "export const helper = 1;\n");
    await writeFile(join(root, "src", "core", "lazy.ts"), "export const lazy = 1;\n");

    const graph = await buildArchitectureMap(root);
    expect(graph.modules.map((module) => module.path)).toEqual([
      "src/core/helper.ts",
      "src/core/lazy.ts",
      "src/index.ts",
    ]);
    expect(queryMap(graph, { from: "src/index.ts" }).map((edge) => edge.to)).toEqual([
      "src/core/helper.ts",
      "src/core/helper.ts",
      "src/core/lazy.ts",
    ]);
    expect(neighbours(graph, "src/core/helper.ts", "in").edges).toHaveLength(2);
  });

  it("resolves ESM .js/.jsx specifiers to their TypeScript source", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "src", "core"), { recursive: true });
    await writeFile(
      join(root, "src", "index.ts"),
      [
        'import { helper } from "./core/helper.js";',
        'import { widget } from "./core/widget.jsx";',
        'await import("./core/lazy.js");',
      ].join("\n"),
    );
    await writeFile(join(root, "src", "core", "helper.ts"), "export const helper = 1;\n");
    await writeFile(join(root, "src", "core", "widget.tsx"), "export const widget = 1;\n");
    await writeFile(join(root, "src", "core", "lazy.ts"), "export const lazy = 1;\n");

    const graph = await buildArchitectureMap(root);
    expect(queryMap(graph, { from: "src/index.ts" }).map((edge) => edge.to)).toEqual([
      "src/core/helper.ts",
      "src/core/lazy.ts",
      "src/core/widget.tsx",
    ]);
  });

  it("still resolves a real .js specifier when the source is .js", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "index.ts"), 'import { j } from "./sibling.js";\n');
    await writeFile(join(root, "src", "sibling.js"), "export const j = 1;\n");

    const graph = await buildArchitectureMap(root);
    expect(queryMap(graph, { from: "src/index.ts" }).map((edge) => edge.to)).toEqual([
      "src/sibling.js",
    ]);
  });
});
