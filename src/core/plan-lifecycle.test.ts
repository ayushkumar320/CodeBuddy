import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlanFileStore } from "./plan-file-store.js";
import {
  ActivePlanExistsError,
  PlanLifecycle,
  PlanNotFoundError,
  PlanTransitionError,
} from "./plan-lifecycle.js";

const roots: string[] = [];

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-lifecycle-"));
  roots.push(root);
  const store = new PlanFileStore(root);
  return new PlanLifecycle(store);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newPlan(lifecycle: PlanLifecycle, namespace = "pathway") {
  return lifecycle.create({ namespace, title: "Add OAuth", brief: "Google sign-in" });
}

describe("PlanLifecycle create", () => {
  it("creates a draft with a generated id and default body", async () => {
    const lifecycle = await harness();
    const plan = await newPlan(lifecycle);
    expect(plan.id).toMatch(/^pln_[a-z0-9]+$/);
    expect(plan.status).toBe("draft");
    expect(plan.body).toContain("# Goal");
  });
});

describe("PlanLifecycle transitions", () => {
  it("walks draft → approved → executing → complete", async () => {
    const lifecycle = await harness();
    const plan = await newPlan(lifecycle);
    expect((await lifecycle.approve(plan.id)).status).toBe("approved");
    expect((await lifecycle.start(plan.id)).status).toBe("executing");
    const done = await lifecycle.complete(plan.id, { commitSha: "abc123" });
    expect(done.status).toBe("complete");
    expect(done.commitSha).toBe("abc123");
    expect(done.completedAt).not.toBeNull();
  });

  it("records timestamps on each transition", async () => {
    const lifecycle = await harness();
    const plan = await newPlan(lifecycle);
    const approved = await lifecycle.approve(plan.id);
    expect(approved.approvedAt).not.toBeNull();
    const executing = await lifecycle.start(plan.id);
    expect(executing.executingAt).not.toBeNull();
  });

  it("can abandon from any non-terminal state with a reason", async () => {
    const lifecycle = await harness();
    const plan = await newPlan(lifecycle);
    const abandoned = await lifecycle.abandon(plan.id, { reason: "blocked upstream" });
    expect(abandoned.status).toBe("abandoned");
    expect(abandoned.abandonReason).toBe("blocked upstream");
  });

  it("rejects illegal transitions", async () => {
    const lifecycle = await harness();
    const plan = await newPlan(lifecycle);
    // draft → executing (must approve first)
    await expect(lifecycle.start(plan.id)).rejects.toBeInstanceOf(PlanTransitionError);
    // complete is terminal
    await lifecycle.approve(plan.id);
    await lifecycle.start(plan.id);
    await lifecycle.complete(plan.id);
    await expect(lifecycle.abandon(plan.id)).rejects.toBeInstanceOf(PlanTransitionError);
  });

  it("throws PlanNotFoundError for an unknown id", async () => {
    const lifecycle = await harness();
    await expect(lifecycle.approve("pln_doesnotexist")).rejects.toBeInstanceOf(PlanNotFoundError);
  });
});

describe("PlanLifecycle single-active enforcement", () => {
  it("refuses to approve a second plan while one is active", async () => {
    const lifecycle = await harness();
    const first = await newPlan(lifecycle);
    const second = await newPlan(lifecycle);
    await lifecycle.approve(first.id);
    await expect(lifecycle.approve(second.id)).rejects.toBeInstanceOf(ActivePlanExistsError);
  });

  it("allows approving a new plan once the previous one completes", async () => {
    const lifecycle = await harness();
    const first = await newPlan(lifecycle);
    const second = await newPlan(lifecycle);
    await lifecycle.approve(first.id);
    await lifecycle.start(first.id);
    await lifecycle.complete(first.id);
    expect((await lifecycle.approve(second.id)).status).toBe("approved");
  });

  it("serializes concurrent approvals so only one wins", async () => {
    const lifecycle = await harness();
    const a = await newPlan(lifecycle);
    const b = await newPlan(lifecycle);
    const results = await Promise.allSettled([lifecycle.approve(a.id), lifecycle.approve(b.id)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it("current() returns the active plan", async () => {
    const lifecycle = await harness();
    const plan = await newPlan(lifecycle);
    await lifecycle.approve(plan.id);
    const current = await lifecycle.current("pathway");
    expect(current?.id).toBe(plan.id);
  });
});

describe("PlanLifecycle amendments", () => {
  it("amends a draft", async () => {
    const lifecycle = await harness();
    const plan = await newPlan(lifecycle);
    const amended = await lifecycle.amend(plan.id, {
      title: "Add OAuth (Google + GitHub)",
      risks: ["Two providers double the surface"],
    });
    expect(amended.title).toBe("Add OAuth (Google + GitHub)");
    expect(amended.risks).toEqual(["Two providers double the surface"]);
    expect(amended.status).toBe("draft");
  });

  it("amends an executing plan", async () => {
    const lifecycle = await harness();
    const plan = await newPlan(lifecycle);
    await lifecycle.approve(plan.id);
    await lifecycle.start(plan.id);
    const amended = await lifecycle.amend(plan.id, { brief: "scope grew" });
    expect(amended.brief).toBe("scope grew");
  });

  it("refuses to amend a completed plan", async () => {
    const lifecycle = await harness();
    const plan = await newPlan(lifecycle);
    await lifecycle.approve(plan.id);
    await lifecycle.start(plan.id);
    await lifecycle.complete(plan.id);
    await expect(lifecycle.amend(plan.id, { brief: "too late" })).rejects.toThrow(
      /only draft or executing/,
    );
  });
});
