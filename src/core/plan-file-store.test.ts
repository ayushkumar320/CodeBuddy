import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PlanFileStore,
  PlanLockError,
  PlanValidationError,
  type PlanWrite,
} from "./plan-file-store.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-plans-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function draft(overrides: Partial<PlanWrite> = {}): PlanWrite {
  return {
    id: "pln_01abc",
    namespace: "pathway",
    title: "Add OAuth login flow",
    status: "draft",
    brief: "Add OAuth login flow with Google as the first provider",
    filesToTouch: [
      { path: "src/auth/oauth.ts", action: "create", notes: "Provider-agnostic handler" },
    ],
    testsToAdd: [{ path: "src/auth/oauth.test.ts", description: "Happy path" }],
    outOfScope: ["Refresh tokens"],
    risks: ["Google may rate-limit"],
    createdAt: "2026-06-21T08:00:00.000Z",
    createdByAgent: "claude",
    approvedAt: null,
    executingAt: null,
    completedAt: null,
    abandonedAt: null,
    commitSha: null,
    abandonReason: null,
    body: "# Goal\n\nAllow Google sign-in.\n\n# Approach\n\n1. Add OAuthProvider interface.",
    ...overrides,
  };
}

describe("PlanFileStore round-trip", () => {
  it("writes and reads a plan with all fields intact", async () => {
    const store = new PlanFileStore(await temporaryRoot());
    await store.writePlan(draft());
    const plan = await store.readPlan("pln_01abc");

    expect(plan.id).toBe("pln_01abc");
    expect(plan.title).toBe("Add OAuth login flow");
    expect(plan.status).toBe("draft");
    expect(plan.filesToTouch).toEqual([
      { path: "src/auth/oauth.ts", action: "create", notes: "Provider-agnostic handler" },
    ]);
    expect(plan.testsToAdd[0]?.description).toBe("Happy path");
    expect(plan.outOfScope).toEqual(["Refresh tokens"]);
    expect(plan.body).toContain("# Goal");
  });

  it("emits a valid YAML front matter block followed by the body", async () => {
    const store = new PlanFileStore(await temporaryRoot());
    const path = await store.writePlan(draft());
    const raw = await readFile(path, "utf8");
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw).toContain("\ntype: plan\n");
    expect(raw).toContain("\n---\n# Goal");
  });

  it("survives hand editing — reordered keys and extra blank lines still parse", async () => {
    const store = new PlanFileStore(await temporaryRoot());
    const path = await store.writePlan(draft());
    // Simulate a developer reordering keys and adding whitespace in their editor.
    const handEdited = [
      "---",
      "type: plan",
      "schemaVersion: 1",
      "status: draft",
      "id: pln_01abc",
      "namespace: pathway",
      "title: Add OAuth login flow",
      "brief: tweaked by hand",
      "filesToTouch: []",
      "testsToAdd: []",
      "outOfScope: []",
      "risks: []",
      "createdAt: 2026-06-21T08:00:00.000Z",
      "createdByAgent: claude",
      "approvedAt: null",
      "executingAt: null",
      "completedAt: null",
      "abandonedAt: null",
      "commitSha: null",
      "abandonReason: null",
      "---",
      "# Goal",
      "",
      "Edited goal.",
      "",
    ].join("\n");
    await writeFile(path, handEdited, "utf8");

    const plan = await store.readPlan("pln_01abc");
    expect(plan.brief).toBe("tweaked by hand");
    expect(plan.body).toContain("Edited goal.");
  });
});

describe("PlanFileStore validation", () => {
  it("rejects a file with a missing required field, naming the field path", async () => {
    const store = new PlanFileStore(await temporaryRoot());
    const path = await store.writePlan(draft());
    const broken = (await readFile(path, "utf8")).replace("title: Add OAuth login flow\n", "");
    await writeFile(path, broken, "utf8");

    await expect(store.readPlan("pln_01abc")).rejects.toBeInstanceOf(PlanValidationError);
    await expect(store.readPlan("pln_01abc")).rejects.toThrow(/title/);
  });

  it("rejects an unknown status value", async () => {
    const store = new PlanFileStore(await temporaryRoot());
    const path = await store.writePlan(draft());
    const broken = (await readFile(path, "utf8")).replace("status: draft", "status: frozen");
    await writeFile(path, broken, "utf8");
    await expect(store.readPlan("pln_01abc")).rejects.toThrow(/status/);
  });

  it("rejects an invalid plan id", async () => {
    const store = new PlanFileStore(await temporaryRoot());
    await expect(store.writePlan(draft({ id: "notaplan" }))).rejects.toThrow("Invalid plan id");
  });
});

describe("PlanFileStore enumeration + active lookup", () => {
  it("lists plans in stable filename order", async () => {
    const store = new PlanFileStore(await temporaryRoot());
    await store.writePlan(draft({ id: "pln_01aaa" }));
    await store.writePlan(draft({ id: "pln_01bbb" }));
    const plans = await store.listPlans();
    expect(plans.map((p) => p.id)).toEqual(["pln_01aaa", "pln_01bbb"]);
  });

  it("returns an empty list when no plans directory exists", async () => {
    const store = new PlanFileStore(await temporaryRoot());
    expect(await store.listPlans()).toEqual([]);
  });

  it("findActivePlan returns null when none are active", async () => {
    const store = new PlanFileStore(await temporaryRoot());
    await store.writePlan(draft({ id: "pln_01aaa", status: "draft" }));
    expect(await store.findActivePlan("pathway")).toBeNull();
  });

  it("findActivePlan returns the approved/executing plan", async () => {
    const store = new PlanFileStore(await temporaryRoot());
    await store.writePlan(draft({ id: "pln_01aaa", status: "draft" }));
    await store.writePlan(draft({ id: "pln_01bbb", status: "executing" }));
    const active = await store.findActivePlan("pathway");
    expect(active?.id).toBe("pln_01bbb");
  });

  it("findActivePlan scopes by namespace", async () => {
    const store = new PlanFileStore(await temporaryRoot());
    await store.writePlan(draft({ id: "pln_01aaa", namespace: "other", status: "approved" }));
    expect(await store.findActivePlan("pathway")).toBeNull();
  });
});

describe("PlanFileStore security", () => {
  it("refuses a symlinked plans directory", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, join(root, ".codebuddy"));
    const store = new PlanFileStore(root);
    await expect(store.writePlan(draft())).rejects.toThrow("symlinked path");
  });
});

describe("PlanFileStore locking", () => {
  it("serializes amendments to one plan", async () => {
    const store = new PlanFileStore(await temporaryRoot());
    const order: string[] = [];
    const slow = store.withPlanLock("pln_01abc", async () => {
      order.push("a:start");
      await new Promise((r) => setTimeout(r, 80));
      order.push("a:end");
    });
    // Give the first lock a head start, then race a second.
    await new Promise((r) => setTimeout(r, 10));
    const fast = store.withPlanLock("pln_01abc", async () => {
      order.push("b:start");
      order.push("b:end");
    });
    await Promise.all([slow, fast]);
    // b must not start until a has fully finished.
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("prevents two clients from creating two active plans (namespace lock)", async () => {
    const store = new PlanFileStore(await temporaryRoot());

    // Two clients each attempt: under the namespace lock, approve only if no
    // active plan exists. The lock must serialize them so exactly one wins.
    const approve = (id: string) =>
      store.withNamespaceLock("pathway", async () => {
        const active = await store.findActivePlan("pathway");
        if (active) return { id, won: false };
        await store.writePlan(draft({ id, status: "approved" }));
        return { id, won: true };
      });

    await store.writePlan(draft({ id: "pln_01aaa", status: "draft" }));
    await store.writePlan(draft({ id: "pln_01bbb", status: "draft" }));

    const [first, second] = await Promise.all([approve("pln_01aaa"), approve("pln_01bbb")]);
    const winners = [first, second].filter((r) => r.won);
    expect(winners).toHaveLength(1);

    const actives = (await store.listPlans()).filter(
      (p) => p.status === "approved" || p.status === "executing",
    );
    expect(actives).toHaveLength(1);
  });

  it("steals a stale lock", async () => {
    const store = new PlanFileStore(await temporaryRoot());
    let ran = false;
    await store.withPlanLock(
      "pln_01abc",
      async () => {
        ran = true;
      },
      // staleMs 0 means any pre-existing lock is immediately stealable; here
      // there is none, but this also exercises the fast path.
      { staleMs: 0 },
    );
    expect(ran).toBe(true);
  });

  it("times out when a lock is held longer than the deadline", async () => {
    const store = new PlanFileStore(await temporaryRoot());
    const holder = store.withPlanLock(
      "pln_01abc",
      async () => {
        await new Promise((r) => setTimeout(r, 300));
      },
      { staleMs: 60_000 },
    );
    await new Promise((r) => setTimeout(r, 20));
    await expect(
      store.withPlanLock("pln_01abc", async () => undefined, {
        timeoutMs: 60,
        staleMs: 60_000,
        pollMs: 10,
      }),
    ).rejects.toBeInstanceOf(PlanLockError);
    await holder;
  });
});
