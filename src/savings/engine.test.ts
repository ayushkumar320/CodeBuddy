import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepository } from "../indexer/engine.js";
import { computeRepoSavings, computeSavings, toCapsule } from "./engine.js";

const roots: string[] = [];

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-savings-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("toCapsule", () => {
  it("computes a positive saving when a summary is smaller than the source", () => {
    const capsule = toCapsule("a.ts", { size: 4000, summary: "ts • 100 lines", symbols: ["a"] });
    expect(capsule.rawTokens).toBe(1000);
    expect(capsule.savedTokens).toBeGreaterThan(0);
    expect(capsule.id).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe("computeSavings", () => {
  it("measures represented files against their raw source and never goes negative", async () => {
    const root = await tempRepo();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src", "big.ts"),
      `export const big = 1;\n${"// filler\n".repeat(500)}`,
    );

    const { stats, capsules } = await computeSavings({
      repositoryRoot: root,
      representedPaths: ["src/big.ts"],
      returnedTokens: 50,
      budget: 4000,
    });

    expect(stats.available).toBe(true);
    expect(stats.representedFiles).toBe(1);
    expect(stats.baselineTokens).toBeGreaterThan(stats.returnedTokens);
    expect(stats.savedTokens).toBe(stats.baselineTokens - stats.returnedTokens);
    expect(stats.compressionRatio).toBeLessThan(1);
    expect(capsules[0]?.path).toBe("src/big.ts");
  });

  it("marks savings unavailable when no files are represented", async () => {
    const root = await tempRepo();
    const { stats } = await computeSavings({
      repositoryRoot: root,
      representedPaths: [],
      returnedTokens: 100,
      budget: 4000,
    });
    expect(stats.available).toBe(false);
    expect(stats.savedTokens).toBe(0);
    expect(stats.compressionRatio).toBe(1);
  });

  it("clamps savings to zero when returned exceeds the baseline", async () => {
    const root = await tempRepo();
    await writeFile(join(root, "tiny.ts"), "a\n"); // ~1 token baseline
    const { stats } = await computeSavings({
      repositoryRoot: root,
      representedPaths: ["tiny.ts"],
      returnedTokens: 9999,
      budget: 4000,
    });
    expect(stats.savedTokens).toBe(0);
    expect(stats.compressionRatio).toBe(1);
    expect(stats.withinBudget).toBe(false);
  });

  it("prefers the index manifest but falls back to reading unindexed files", async () => {
    const root = await tempRepo();
    await writeFile(join(root, "a.ts"), `export const a = 1;\n${"x\n".repeat(200)}`);
    // Not indexed yet — savings must still be computable via fallback read.
    const before = await computeSavings({
      repositoryRoot: root,
      representedPaths: ["a.ts"],
      returnedTokens: 20,
      budget: 4000,
    });
    expect(before.stats.baselineTokens).toBeGreaterThan(0);

    await indexRepository({ repositoryRoot: root });
    const after = await computeSavings({
      repositoryRoot: root,
      representedPaths: ["a.ts"],
      returnedTokens: 20,
      budget: 4000,
    });
    expect(after.stats.baselineTokens).toBe(before.stats.baselineTokens);
  });
});

describe("computeRepoSavings", () => {
  it("reports unavailable savings before indexing", async () => {
    const root = await tempRepo();
    const result = await computeRepoSavings(root);
    expect(result.savings.available).toBe(false);
    expect(result.savings.note).toMatch(/codebuddy index/);
  });

  it("summarizes the project and measures savings from the manifest", async () => {
    const root = await tempRepo();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), `export const a = 1;\n${"// x\n".repeat(300)}`);
    await writeFile(join(root, "README.md"), "# Title\n");
    await indexRepository({ repositoryRoot: root });

    const result = await computeRepoSavings(root);
    expect(result.savings.available).toBe(true);
    expect(result.savings.savedTokens).toBeGreaterThan(0);
    expect(result.project.files).toBe(2);
    expect(result.project.topDirectories.map((d) => d.directory)).toContain("src");
  });
});
