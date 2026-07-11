import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProjectScaffold } from "./config-file.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("initProjectScaffold review privacy", () => {
  it("ignores review memory in new and existing scaffolds", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-config-"));
    roots.push(root);
    await initProjectScaffold(root);
    const path = join(root, ".codebuddy", ".gitignore");
    expect(await readFile(path, "utf8")).toContain("/memory/review/");

    await writeFile(path, "# user rule\n/custom/\n");
    await initProjectScaffold(root);
    const updated = await readFile(path, "utf8");
    expect(updated).toContain("/custom/");
    expect(updated.match(/\/memory\/review\//g)).toHaveLength(1);
  });
});
