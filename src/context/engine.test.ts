import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryFileStore } from "../core/memory-file-store.js";
import { PlanFileStore } from "../core/plan-file-store.js";
import { PlanLifecycle } from "../core/plan-lifecycle.js";
import { buildBeforeEditContext, buildBootstrapContext } from "./engine.js";

const roots: string[] = [];

const POLICY_FILE = [
  "rules:",
  "  - id: auth-sensitive",
  '    pattern: "src/auth/**"',
  '    message: "Auth changes need careful review."',
  "    weight: 70",
  "",
].join("\n");

async function seedRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-context-"));
  roots.push(root);

  // Source files that produce a couple of import edges.
  await mkdir(join(root, "src", "auth"), { recursive: true });
  await writeFile(
    join(root, "src", "auth", "oauth.ts"),
    'import { verify } from "./verify";\nexport const login = () => verify();\n',
  );
  await writeFile(join(root, "src", "auth", "verify.ts"), "export const verify = () => true;\n");

  // Policy scaffold.
  await mkdir(join(root, ".codebuddy"), { recursive: true });
  await writeFile(join(root, ".codebuddy", "policies.yaml"), POLICY_FILE);

  // An active plan.
  const lifecycle = new PlanLifecycle(new PlanFileStore(root));
  const plan = await lifecycle.create({
    namespace: "proj",
    title: "Fix OAuth callback",
    brief: "Restore the dropped state parameter",
    filesToTouch: [{ path: "src/auth/oauth.ts", action: "edit", notes: "" }],
    risks: ["callback regressions"],
  });
  await lifecycle.approve(plan.id);

  // An unresolved incident touching the auth path.
  await new MemoryFileStore(root).writeFact({
    id: "fact_oauthincident",
    namespace: "proj",
    subject: "OAuth callback regression",
    predicate: "dropped",
    object: "state parameter on callback",
    confidence: 0.9,
    createdAt: "2026-06-01T00:00:00.000Z",
    createdByAgent: "claude",
    sourceInteractionId: null,
    sourceDeleted: false,
    content: "The OAuth callback dropped the state parameter, breaking sign-in.",
    category: "incident",
    paths: ["src/auth/oauth.ts"],
    severity: "high",
  });

  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("buildBootstrapContext", () => {
  it("returns identity, active plan, policy, incidents, and architecture", async () => {
    const root = await seedRepo();
    const ctx = await buildBootstrapContext({ repositoryRoot: root, namespace: "proj" });

    expect(ctx.project).toEqual({ namespace: "proj", root });
    expect(ctx.plan?.title).toBe("Fix OAuth callback");
    expect(ctx.plan?.status).toBe("approved");
    expect(ctx.policy).toBe("suggest");
    expect(ctx.policyRules.map((rule) => rule.id)).toContain("auth-sensitive");
    expect(ctx.incidents[0]?.id).toBe("fact_oauthincident");
    expect(ctx.incidents[0]?.severity).toBe("high");
    expect(ctx.architecture.moduleCount).toBeGreaterThan(0);
    expect(ctx.architecture.edgeCount).toBeGreaterThan(0);
    expect(ctx.tokens.returnedEstimate).toBeGreaterThan(0);
    expect(ctx.tokens.savings.available).toBe(false);
    expect(ctx.explain.length).toBeGreaterThan(0);
  });

  it("reports no active plan when none is approved", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebuddy-context-"));
    roots.push(root);
    const ctx = await buildBootstrapContext({ repositoryRoot: root, namespace: "empty" });
    expect(ctx.plan).toBeNull();
    expect(ctx.incidents).toEqual([]);
    expect(ctx.explain).toContain("plan: no active plan");
  });
});

describe("buildBeforeEditContext", () => {
  it("resolves explicit paths and attaches matching plan, policy, incident, and risk", async () => {
    const root = await seedRepo();
    const ctx = await buildBeforeEditContext({
      repositoryRoot: root,
      namespace: "proj",
      task: "fix the OAuth callback",
      paths: ["src/auth/oauth.ts"],
    });

    expect(ctx.targetPaths).toEqual(["src/auth/oauth.ts"]);
    expect(ctx.pathSource).toBe("paths");
    expect(ctx.task).toBe("fix the OAuth callback");
    expect(ctx.plan?.title).toBe("Fix OAuth callback");
    expect(ctx.policyRules.map((rule) => rule.id)).toContain("auth-sensitive");
    expect(ctx.incidents.map((incident) => incident.id)).toContain("fact_oauthincident");
    expect(ctx.risks.items.length).toBeGreaterThan(0);
    expect(ctx.neighbours.find((n) => n.path === "src/auth/oauth.ts")?.dependsOn).toContain(
      "src/auth/verify.ts",
    );
  });

  it("resolves target files from a plan id", async () => {
    const root = await seedRepo();
    const plan = (await new PlanFileStore(root).listPlans())[0];
    expect(plan).toBeDefined();
    const ctx = await buildBeforeEditContext({
      repositoryRoot: root,
      namespace: "proj",
      planId: (plan as { id: string }).id,
    });
    expect(ctx.pathSource).toBe("plan");
    expect(ctx.targetPaths).toContain("src/auth/oauth.ts");
  });

  it("does not include incidents for unrelated paths", async () => {
    const root = await seedRepo();
    const ctx = await buildBeforeEditContext({
      repositoryRoot: root,
      namespace: "proj",
      paths: ["src/auth/verify.ts"],
    });
    expect(ctx.incidents).toEqual([]);
  });
});
