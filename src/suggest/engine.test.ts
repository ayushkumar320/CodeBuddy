import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryFileStore } from "../core/memory-file-store.js";
import { PlanFileStore } from "../core/plan-file-store.js";
import { PlanLifecycle } from "../core/plan-lifecycle.js";
import { generateSuggestions } from "./engine.js";
import { SEVERITY_RANK } from "./types.js";

const roots: string[] = [];

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-suggest-"));
  roots.push(root);
  return root;
}

async function tree(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push(rel);
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
    }
  };
  await walk(root, "");
  return out.sort();
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("generateSuggestions", () => {
  it("suggests missing tests and stale policies with evidence, ranked by severity", async () => {
    const root = await tempRepo();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "untested.ts"), "export const a = 1;\n");
    await mkdir(join(root, ".codebuddy"), { recursive: true });
    await writeFile(
      join(root, ".codebuddy", "policies.yaml"),
      'rules:\n  - id: gone\n    pattern: "does/not/exist/**"\n    weight: 50\n',
    );

    // An unresolved incident on the same file → high severity.
    await new MemoryFileStore(root).writeFact({
      id: "fact_incidentx",
      namespace: "proj",
      subject: "prior outage",
      predicate: "occurred",
      object: "in untested.ts",
      confidence: 0.9,
      createdAt: "2026-06-01T00:00:00.000Z",
      createdByAgent: null,
      sourceInteractionId: null,
      sourceDeleted: false,
      content: "It broke once.",
      category: "incident",
      paths: ["src/untested.ts"],
      severity: "high",
    });

    const result = await generateSuggestions({
      repositoryRoot: root,
      namespace: "proj",
      paths: ["src/untested.ts"],
    });

    const categories = result.suggestions.map((s) => s.category);
    expect(categories).toContain("incident");
    expect(categories).toContain("missing_test");
    expect(categories).toContain("stale_policy");

    // Every suggestion carries evidence.
    expect(result.suggestions.every((s) => s.evidence.length > 0)).toBe(true);

    // Severity is non-increasing (highest first).
    const ranks = result.suggestions.map((s) => SEVERITY_RANK[s.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    expect(result.suggestions[0]?.category).toBe("incident");
  });

  it("flags divergence when the change set leaves the active plan's scope", async () => {
    const root = await tempRepo();
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "b.ts"), "export const b = 2;\n");
    const lifecycle = new PlanLifecycle(new PlanFileStore(root));
    const plan = await lifecycle.create({
      namespace: "proj",
      title: "Only touch a.ts",
      brief: "scoped",
      filesToTouch: [{ path: "a.ts", action: "edit", notes: "" }],
    });
    await lifecycle.approve(plan.id);

    const result = await generateSuggestions({
      repositoryRoot: root,
      namespace: "proj",
      paths: ["a.ts", "b.ts"],
    });
    const divergence = result.suggestions.find((s) => s.category === "plan_divergence");
    expect(divergence).toBeDefined();
    expect(divergence?.detail).toContain("b.ts");
  });

  it("does not emit missing_test when a sibling test exists", async () => {
    const root = await tempRepo();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "covered.ts"), "export const a = 1;\n");
    await writeFile(join(root, "src", "covered.test.ts"), "test.skip('x', () => {});\n");

    const result = await generateSuggestions({
      repositoryRoot: root,
      namespace: "proj",
      paths: ["src/covered.ts"],
    });
    expect(result.suggestions.some((s) => s.category === "missing_test")).toBe(false);
  });

  it("is read-only: it never touches project files (only CodeBuddy scaffold dirs)", async () => {
    const root = await tempRepo();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "x.ts"), "export const x = 1;\n");
    // Reading via the plan/memory stores may lazily create empty .codebuddy
    // scaffold dirs; that is benign. What must not change is project code.
    const projectFiles = (paths: string[]) => paths.filter((p) => !p.startsWith(".codebuddy"));
    const before = projectFiles(await tree(root));

    await generateSuggestions({ repositoryRoot: root, namespace: "proj", paths: ["src/x.ts"] });

    expect(projectFiles(await tree(root))).toEqual(before);
  });

  it("respects the limit", async () => {
    const root = await tempRepo();
    await mkdir(join(root, "src"), { recursive: true });
    for (const name of ["a", "b", "c"]) {
      await writeFile(join(root, "src", `${name}.ts`), "export const v = 1;\n");
    }
    const result = await generateSuggestions({
      repositoryRoot: root,
      namespace: "proj",
      paths: ["src/a.ts", "src/b.ts", "src/c.ts"],
      limit: 2,
    });
    expect(result.suggestions.length).toBeLessThanOrEqual(2);
  });
});
