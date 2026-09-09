import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadGraphifyMap } from "./graphify.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("loadGraphifyMap", () => {
  it("imports file relationships and normalizes absolute paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-graphify-"));
    roots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "graph.json"),
      JSON.stringify({
        nodes: [
          { id: "a", path: join(root, "src", "a.ts") },
          { id: "b", path: "src/b.ts" },
        ],
        edges: [{ source: "a", target: "b", type: "imports" }],
      }),
    );
    const graph = await loadGraphifyMap(join(root, "graph.json"), root);
    expect(graph.modules.map((module) => module.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(graph.edges).toEqual([{ from: "src/a.ts", to: "src/b.ts", kind: "import" }]);
  });
});
