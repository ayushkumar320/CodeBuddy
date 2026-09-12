import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryFileStore } from "../core/memory-file-store.js";
import { PlanFileStore } from "../core/plan-file-store.js";
import { PlanLifecycle } from "../core/plan-lifecycle.js";
import { indexRepository } from "../indexer/engine.js";
import { buildBeforeEditContext, buildBootstrapContext } from "./engine.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

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

async function writeGraphifyGraph(root: string, graph: unknown): Promise<void> {
  await mkdir(join(root, "graphify-out"), { recursive: true });
  await writeFile(join(root, "graphify-out", "graph.json"), JSON.stringify(graph));
  await writeFile(
    join(root, ".codebuddy", "config.json"),
    JSON.stringify({
      namespace: "proj",
      graphify: { enabled: true, graphPath: "graphify-out/graph.json" },
    }),
  );
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
    // Architecture hotspots are represented, so savings is measurable.
    expect(ctx.tokens.savings.available).toBe(true);
    expect(ctx.tokens.savings.savedTokens).toBeGreaterThanOrEqual(0);
    expect(ctx.explain.length).toBeGreaterThan(0);
  });

  it("uses a Graphify node-link graph for the architecture map", async () => {
    const root = await seedRepo();
    // Relative and absolute source_file paths, plus an edge the regex import
    // map cannot see, so these counts can only come from Graphify.
    await writeGraphifyGraph(root, {
      nodes: [
        { id: "oauth_login", source_file: "src/auth/oauth.ts" },
        { id: "verify_fn", source_file: join(root, "src", "auth", "verify.ts") },
        { id: "session_store", source_file: "src/auth/session.ts" },
        { id: "env_only", label: "CODEBUDDY_NAMESPACE" },
      ],
      links: [
        { source: "oauth_login", target: "verify_fn", relation: "imports_from" },
        { source: "oauth_login", target: "session_store", relation: "calls" },
        { source: "oauth_login", target: "env_only", relation: "requires_env" },
      ],
    });
    const ctx = await buildBootstrapContext({ repositoryRoot: root, namespace: "proj" });
    expect(ctx.architecture.moduleCount).toBe(3);
    expect(ctx.architecture.edgeCount).toBe(2);
  });

  it("reports the symbols a file uses from each dependency", async () => {
    const root = await seedRepo();
    await writeGraphifyGraph(root, {
      nodes: [
        { id: "login", label: "login()", source_file: "src/auth/oauth.ts" },
        { id: "verify", label: "verify()", source_file: "src/auth/verify.ts" },
      ],
      links: [{ source: "login", target: "verify", relation: "imports_from" }],
    });
    const ctx = await buildBeforeEditContext({
      repositoryRoot: root,
      namespace: "proj",
      task: "fix the OAuth callback",
      paths: ["src/auth/oauth.ts"],
    });
    const neighbour = ctx.neighbours.find((entry) => entry.path === "src/auth/oauth.ts");
    expect(neighbour?.dependsOn).toEqual(["src/auth/verify.ts"]);
    expect(neighbour?.usesSymbols).toEqual({ "src/auth/verify.ts": ["verify()"] });
  });

  it("omits usesSymbols when the architecture source has no symbol names", async () => {
    const root = await seedRepo();
    const ctx = await buildBeforeEditContext({
      repositoryRoot: root,
      namespace: "proj",
      task: "fix the OAuth callback",
      paths: ["src/auth/oauth.ts"],
    });
    expect(ctx.neighbours[0]?.usesSymbols).toBeUndefined();
  });

  it("falls back to the built-in map when the Graphify graph has no usable relationships", async () => {
    const root = await seedRepo();
    await writeGraphifyGraph(root, {
      nodes: [
        { id: "a", source_file: "src/auth/oauth.ts" },
        { id: "b", source_file: "src/auth/oauth.ts" },
      ],
      links: [{ source: "a", target: "b", relation: "calls" }],
    });
    const ctx = await buildBootstrapContext({ repositoryRoot: root, namespace: "proj" });
    expect(ctx.architecture.moduleCount).toBeGreaterThan(0);
    expect(ctx.architecture.edgeCount).toBeGreaterThan(0);
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
    // N.3: the target file's public API is returned as signatures, not full source.
    const api = ctx.symbols.find((s) => s.path === "src/auth/oauth.ts");
    expect(api?.signatures.some((sig) => sig.includes("login"))).toBe(true);
  });

  it("includes bounded Git diff hunks for the current target", async () => {
    const root = await seedRepo();
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "CodeBuddy Test"], { cwd: root });
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: root });
    await writeFile(
      join(root, "src", "auth", "oauth.ts"),
      'import { verify } from "./verify";\nexport const login = () => verify();\nexport const state = "preserved";\n',
    );

    const ctx = await buildBeforeEditContext({
      repositoryRoot: root,
      namespace: "proj",
      paths: ["src/auth/oauth.ts"],
    });

    expect(ctx.diffs).toHaveLength(1);
    expect(ctx.diffs[0]?.path).toBe("src/auth/oauth.ts");
    expect(ctx.diffs[0]?.patch).toContain('+export const state = "preserved";');
  });

  it("includes untracked files and marks oversized patches as truncated", async () => {
    const root = await seedRepo();
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    const path = "src/auth/new-provider.ts";
    await writeFile(join(root, path), `${"export const provider = true;\n".repeat(300)}`);

    const ctx = await buildBeforeEditContext({
      repositoryRoot: root,
      namespace: "proj",
      paths: [path],
    });

    expect(ctx.diffs[0]?.path).toBe(path);
    expect(ctx.diffs[0]?.truncated).toBe(true);
    expect(ctx.diffs[0]?.patch).toContain("new file mode 100644");
  });

  it("keeps deleted and renamed files in Git diff context", async () => {
    const root = await seedRepo();
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "CodeBuddy Test"], { cwd: root });
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: root });
    await execFileAsync("git", ["mv", "src/auth/verify.ts", "src/auth/check.ts"], { cwd: root });
    await execFileAsync("git", ["rm", "src/auth/oauth.ts"], { cwd: root });

    const ctx = await buildBeforeEditContext({
      repositoryRoot: root,
      namespace: "proj",
      paths: ["src/auth/check.ts", "src/auth/oauth.ts"],
    });

    expect(ctx.diffs.map((diff) => diff.path)).toContain("src/auth/check.ts");
    expect(ctx.diffs.map((diff) => diff.path)).toContain("src/auth/oauth.ts");
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

  it("discovers relevant files from the indexed task when paths are omitted", async () => {
    const root = await seedRepo();
    await indexRepository({ repositoryRoot: root });
    const ctx = await buildBeforeEditContext({
      repositoryRoot: root,
      namespace: "proj",
      task: "fix the OAuth callback",
      useGit: false,
    });
    expect(ctx.pathSource).toBe("task");
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

  it("enforces a tight token budget by dropping lower-priority context", async () => {
    const root = await seedRepo();
    const ctx = await buildBeforeEditContext({
      repositoryRoot: root,
      namespace: "proj",
      paths: ["src/auth/oauth.ts"],
      tokenBudget: 500,
    });
    expect(ctx.tokens.returnedEstimate).toBeLessThanOrEqual(500);
    expect(ctx.policyRules.map((rule) => rule.id)).toContain("auth-sensitive");
    expect(ctx.incidents.map((incident) => incident.id)).toContain("fact_oauthincident");
    expect(ctx.neighbours).toEqual([]);
  });

  it("ranks durable facts by the task instead of recency alone", async () => {
    const root = await seedRepo();
    const store = new MemoryFileStore(root);
    const base = {
      namespace: "proj",
      predicate: "decided",
      confidence: 0.9,
      createdByAgent: "codex",
      sourceInteractionId: null,
      sourceDeleted: false,
      category: "general" as const,
      paths: ["src/auth/oauth.ts"],
    };
    await store.writeFact({
      ...base,
      id: "fact_authdecision",
      subject: "OAuth state validation",
      object: "validate state before exchanging the authorization code",
      content: "OAuth callbacks validate state before exchanging the authorization code.",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    await store.writeFact({
      ...base,
      id: "fact_databasedecision",
      subject: "Database pooling",
      object: "use a bounded Postgres connection pool",
      content: "Database access uses a bounded Postgres connection pool.",
      createdAt: "2026-07-01T00:00:00.000Z",
      paths: [],
    });

    const auth = await buildBeforeEditContext({
      repositoryRoot: root,
      namespace: "proj",
      task: "fix OAuth state validation",
      paths: ["src/auth/oauth.ts"],
    });
    const database = await buildBeforeEditContext({
      repositoryRoot: root,
      namespace: "proj",
      task: "review database Postgres pooling",
      paths: ["src/auth/oauth.ts"],
    });
    expect(auth.facts[0]?.id).toBe("fact_authdecision");
    expect(database.facts[0]?.id).toBe("fact_databasedecision");
    expect(auth.facts[0]?.reason).toMatch(/target path|relevance/);

    const fallback = await buildBeforeEditContext({
      repositoryRoot: root,
      namespace: "proj",
      task: "fix OAuth state validation",
      paths: ["src/auth/oauth.ts"],
      semanticRanker: async () => {
        throw new Error("embedding service unavailable");
      },
    });
    expect(fallback.facts.map((fact) => fact.id)).toEqual(auth.facts.map((fact) => fact.id));
  });
});
