import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepository } from "./engine.js";
import { IndexStore } from "./store.js";

const roots: string[] = [];

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-index-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("indexRepository", () => {
  it("indexes supported files and writes a manifest", async () => {
    const root = await tempRepo();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "README.md"), "# Title\n");
    await writeFile(join(root, "logo.png"), "binary-ish");

    const result = await indexRepository({ repositoryRoot: root });
    expect(result.added).toBe(2); // a.ts + README.md; logo.png is unsupported
    expect(result.totalIndexed).toBe(2);

    const manifest = await new IndexStore(root).read();
    expect(manifest.entries["src/a.ts"]?.symbols).toEqual(["a"]);
    expect(manifest.entries["src/a.ts"]?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.entries["logo.png"]).toBeUndefined();
  });

  it("records a symbol table for code files (N.3)", async () => {
    const root = await tempRepo();
    await writeFile(join(root, "a.ts"), "export function login() {}\nexport const MAX = 1;\n");
    await writeFile(join(root, "README.md"), "# Title\n");

    await indexRepository({ repositoryRoot: root });
    const manifest = await new IndexStore(root).read();
    expect(manifest.entries["a.ts"]?.symbolTable?.map((s) => s.name)).toEqual(["login", "MAX"]);
    // Non-code files carry no symbol table.
    expect(manifest.entries["README.md"]?.symbolTable).toBeUndefined();
  });

  it("skips unchanged files on the second pass", async () => {
    const root = await tempRepo();
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");

    const first = await indexRepository({ repositoryRoot: root });
    expect(first.added).toBe(1);

    const second = await indexRepository({ repositoryRoot: root });
    expect(second.added).toBe(0);
    expect(second.changed).toBe(0);
    expect(second.unchanged).toBe(1);
  });

  it("detects changed content and re-summarizes", async () => {
    const root = await tempRepo();
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");
    await indexRepository({ repositoryRoot: root });

    await writeFile(join(root, "a.ts"), "export const a = 1;\nexport const b = 2;\n");
    const result = await indexRepository({ repositoryRoot: root });
    expect(result.changed).toBe(1);
    expect(result.unchanged).toBe(0);

    const manifest = await new IndexStore(root).read();
    expect(manifest.entries["a.ts"]?.symbols).toEqual(["a", "b"]);
  });

  it("prunes entries for deleted files", async () => {
    const root = await tempRepo();
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "b.ts"), "export const b = 2;\n");
    await indexRepository({ repositoryRoot: root });

    await rm(join(root, "b.ts"));
    const result = await indexRepository({ repositoryRoot: root });
    expect(result.removed).toBe(1);
    expect(result.unchanged).toBe(1);

    const manifest = await new IndexStore(root).read();
    expect(manifest.entries["b.ts"]).toBeUndefined();
  });

  it("re-summarizes everything under --full", async () => {
    const root = await tempRepo();
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");
    await indexRepository({ repositoryRoot: root });

    const result = await indexRepository({ repositoryRoot: root, full: true });
    expect(result.changed).toBe(1);
    expect(result.unchanged).toBe(0);
  });

  it("never indexes CodeBuddy's own .codebuddy artifacts", async () => {
    const root = await tempRepo();
    await mkdir(join(root, ".codebuddy", "plans"), { recursive: true });
    await writeFile(join(root, ".codebuddy", "plans", "p.md"), "# plan\n");
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");

    const result = await indexRepository({ repositoryRoot: root });
    expect(result.totalIndexed).toBe(1);
    const manifest = await new IndexStore(root).read();
    expect(Object.keys(manifest.entries)).toEqual(["a.ts"]);
  });

  it("respects .gitignore when the directory is a git repo", async () => {
    const root = await tempRepo();
    const git = (args: string[]) => spawnSync("git", args, { cwd: root });
    if (git(["init"]).status !== 0) return; // git unavailable: skip
    git(["config", "user.email", "t@t.dev"]);
    git(["config", "user.name", "t"]);
    await writeFile(join(root, ".gitignore"), "ignored.ts\n");
    await writeFile(join(root, "kept.ts"), "export const kept = 1;\n");
    await writeFile(join(root, "ignored.ts"), "export const ignored = 1;\n");

    const result = await indexRepository({ repositoryRoot: root });
    const manifest = await new IndexStore(root).read();
    expect(manifest.entries["kept.ts"]).toBeDefined();
    expect(manifest.entries["ignored.ts"]).toBeUndefined();
    expect(result.totalIndexed).toBe(1);
  });
});
