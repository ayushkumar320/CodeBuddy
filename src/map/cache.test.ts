import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepository } from "../indexer/engine.js";
import { IndexStore } from "../indexer/store.js";
import { loadArchitectureMap } from "./cache.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-map-cache-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), 'import { b } from "./b.js";\nexport const a = b;\n');
  await writeFile(join(root, "src", "b.ts"), "export const b = 1;\n");
  return root;
}

describe("architecture cache", () => {
  it("reads no source files on an unchanged warm load", async () => {
    const root = await repo();
    const initial = await indexRepository({ repositoryRoot: root });
    expect(initial.architecture.source).toBe("rebuild");
    expect(initial.architecture.readFiles).toBe(2);
    const manifest = await new IndexStore(root).read();
    const warm = await loadArchitectureMap(root, manifest);
    expect(warm.source).toBe("cache");
    expect(warm.stats.readFiles).toBe(0);
    expect(warm.stats.reusedFiles).toBe(2);
  });

  it("reparses only a changed file when the source set is stable", async () => {
    const root = await repo();
    await indexRepository({ repositoryRoot: root });
    await writeFile(
      join(root, "src", "a.ts"),
      'import { b } from "./b.js";\nexport const a = b + 1;\n',
    );
    const incremental = await indexRepository({ repositoryRoot: root });
    expect(incremental.architecture.source).toBe("incremental");
    expect(incremental.architecture.readFiles).toBe(1);
    expect(incremental.architecture.reusedFiles).toBe(1);
    const warm = await loadArchitectureMap(root, await new IndexStore(root).read());
    expect(warm.stats.readFiles).toBe(0);

    const cache = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        join(root, ".codebuddy", "cache", "architecture.json"),
        "utf8",
      ),
    ) as { map: { modules: unknown[] } };
    expect(cache.map.modules).toHaveLength(2);
  });

  it("removes deleted nodes and recovers from corrupt cache", async () => {
    const root = await repo();
    await indexRepository({ repositoryRoot: root });
    await rm(join(root, "src", "b.ts"));
    await indexRepository({ repositoryRoot: root });
    let result = await loadArchitectureMap(root, await new IndexStore(root).read());
    expect(result.map.modules.map((module) => module.path)).toEqual(["src/a.ts"]);

    await writeFile(join(root, ".codebuddy", "cache", "architecture.json"), "broken");
    result = await loadArchitectureMap(root, await new IndexStore(root).read());
    expect(result.source).toBe("rebuild");
    expect(result.map.modules.map((module) => module.path)).toEqual(["src/a.ts"]);
  });
});
