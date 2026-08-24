import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlanFileStore } from "../core/plan-file-store.js";
import { PlanLifecycle } from "../core/plan-lifecycle.js";
import { assessRisk, MAX_RESOLVED_PATHS, resolveRiskPaths } from "./service.js";
import type { Signal } from "./types.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-risk-service-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("resolveRiskPaths", () => {
  it("resolves paths from a plan id", async () => {
    const root = await temporaryRoot();
    const lifecycle = new PlanLifecycle(new PlanFileStore(root));
    const plan = await lifecycle.create({
      namespace: "demo",
      title: "Change auth",
      brief: "Touch auth files",
      filesToTouch: [{ path: "src/auth/oauth.ts", action: "edit", notes: "" }],
    });

    await expect(resolveRiskPaths({ repositoryRoot: root, planId: plan.id })).resolves.toEqual([
      "src/auth/oauth.ts",
    ]);
  });

  it("drops traversal escapes and caps the resolved set", async () => {
    const root = await temporaryRoot();
    const result = await resolveRiskPaths({
      repositoryRoot: root,
      paths: [
        "src/ok.ts",
        "../outside.txt",
        "../../etc/passwd",
        "/absolute/elsewhere.ts",
        "src/../src/nested.md",
      ],
    });
    // Escapes are dropped; `src/../src/nested.md` normalizes to inside the
    // repo and is kept (as its normalized form).
    expect(result).toEqual(["src/nested.md", "src/ok.ts"]);
  });

  it("never returns more than MAX_RESOLVED_PATHS entries", async () => {
    const root = await temporaryRoot();
    const many = Array.from({ length: MAX_RESOLVED_PATHS + 25 }, (_, i) => `src/f${i}.ts`);
    const result = await resolveRiskPaths({ repositoryRoot: root, paths: many });
    expect(result).toHaveLength(MAX_RESOLVED_PATHS);
  });
});

describe("assessRisk", () => {
  it("accepts injected signals for deterministic tests", async () => {
    const root = await temporaryRoot();
    const signal: Signal = {
      id: "fake",
      category: "policy",
      enabled: true,
      coefficient: 1,
      assess: async () => [
        {
          path: "src/a.ts",
          weight: 42,
          reason: "fixture",
          evidence: [{ kind: "policy_rule", ruleId: "fixture", pattern: "src/**" }],
        },
      ],
    };

    const result = await assessRisk({
      repositoryRoot: root,
      namespace: "demo",
      paths: ["src/a.ts"],
      signals: [signal],
    });

    expect(result.items[0]?.score).toBe(42);
  });
});
