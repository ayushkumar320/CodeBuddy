import { generateEntityId } from "./ids.js";
import {
  ACTIVE_PLAN_STATUSES,
  type PlanFileStore,
  type PlannedFile,
  type PlannedTest,
  type PlanSpec,
  type PlanStatus,
} from "./plan-file-store.js";

/**
 * The plan lifecycle service enforces the state machine on top of the
 * file store. The store knows how to read/write/lock; this service knows
 * which transitions are legal and guarantees that at most one plan in a
 * namespace is active at a time. Transitions that change active state run
 * under the namespace lock; amendments run under the per-plan lock.
 */

/** Legal transitions. Terminal states (complete, abandoned) have none. */
const TRANSITIONS: Record<PlanStatus, readonly PlanStatus[]> = {
  draft: ["approved", "abandoned"],
  approved: ["executing", "abandoned"],
  executing: ["complete", "abandoned"],
  complete: [],
  abandoned: [],
};

/** Only these states accept content amendments. */
const AMENDABLE: readonly PlanStatus[] = ["draft", "executing"];

export class PlanTransitionError extends Error {
  constructor(from: PlanStatus, to: PlanStatus) {
    super(`Illegal plan transition: ${from} → ${to}.`);
    this.name = "PlanTransitionError";
  }
}

export class PlanNotFoundError extends Error {
  constructor(id: string) {
    super(`Plan ${id} not found.`);
    this.name = "PlanNotFoundError";
  }
}

export class ActivePlanExistsError extends Error {
  readonly activePlanId: string;
  constructor(namespace: string, activePlanId: string) {
    super(
      `Namespace "${namespace}" already has an active plan (${activePlanId}). ` +
        `Complete or abandon it before approving another.`,
    );
    this.name = "ActivePlanExistsError";
    this.activePlanId = activePlanId;
  }
}

export type CreatePlanInput = {
  namespace: string;
  title: string;
  brief: string;
  body?: string;
  filesToTouch?: PlannedFile[];
  testsToAdd?: PlannedTest[];
  outOfScope?: string[];
  risks?: string[];
  createdByAgent?: string | null;
  now?: string;
};

export type AmendPlanPatch = {
  title?: string;
  brief?: string;
  body?: string;
  filesToTouch?: PlannedFile[];
  testsToAdd?: PlannedTest[];
  outOfScope?: string[];
  risks?: string[];
};

export type CompleteOptions = { commitSha?: string; notes?: string };
export type AbandonOptions = { reason?: string };

const DEFAULT_BODY = [
  "# Goal",
  "",
  "(what this plan achieves)",
  "",
  "# Approach",
  "",
  "(ordered steps)",
  "",
  "# Notes",
  "",
  "(freeform; ignored by tooling)",
].join("\n");

export class PlanLifecycle {
  private readonly store: PlanFileStore;

  constructor(store: PlanFileStore) {
    this.store = store;
  }

  async create(input: CreatePlanInput): Promise<PlanSpec> {
    const id = generateEntityId("pln");
    const now = input.now ?? new Date().toISOString();
    await this.store.writePlan({
      id,
      namespace: input.namespace,
      title: input.title,
      status: "draft",
      brief: input.brief,
      filesToTouch: input.filesToTouch ?? [],
      testsToAdd: input.testsToAdd ?? [],
      outOfScope: input.outOfScope ?? [],
      risks: input.risks ?? [],
      createdAt: now,
      createdByAgent: input.createdByAgent ?? null,
      approvedAt: null,
      executingAt: null,
      completedAt: null,
      abandonedAt: null,
      commitSha: null,
      abandonReason: null,
      body: input.body ?? DEFAULT_BODY,
    });
    return this.store.readPlan(id);
  }

  async approve(id: string, now = new Date().toISOString()): Promise<PlanSpec> {
    const current = await this.require(id);
    // The active-plan guard and the write must be atomic across the
    // namespace, otherwise two approvals could both observe "no active plan".
    return this.store.withNamespaceLock(current.namespace, async () => {
      const fresh = await this.require(id);
      this.assertTransition(fresh.status, "approved");
      const active = await this.store.findActivePlan(fresh.namespace);
      if (active && active.id !== id) {
        throw new ActivePlanExistsError(fresh.namespace, active.id);
      }
      return this.rewrite(fresh, { status: "approved", approvedAt: now });
    });
  }

  async start(id: string, now = new Date().toISOString()): Promise<PlanSpec> {
    const current = await this.require(id);
    return this.store.withNamespaceLock(current.namespace, async () => {
      const fresh = await this.require(id);
      this.assertTransition(fresh.status, "executing");
      return this.rewrite(fresh, { status: "executing", executingAt: now });
    });
  }

  async complete(
    id: string,
    options: CompleteOptions = {},
    now = new Date().toISOString(),
  ): Promise<PlanSpec> {
    const current = await this.require(id);
    return this.store.withNamespaceLock(current.namespace, async () => {
      const fresh = await this.require(id);
      this.assertTransition(fresh.status, "complete");
      return this.rewrite(fresh, {
        status: "complete",
        completedAt: now,
        ...(options.commitSha !== undefined ? { commitSha: options.commitSha } : {}),
      });
    });
  }

  async abandon(
    id: string,
    options: AbandonOptions = {},
    now = new Date().toISOString(),
  ): Promise<PlanSpec> {
    const current = await this.require(id);
    return this.store.withNamespaceLock(current.namespace, async () => {
      const fresh = await this.require(id);
      this.assertTransition(fresh.status, "abandoned");
      return this.rewrite(fresh, {
        status: "abandoned",
        abandonedAt: now,
        ...(options.reason !== undefined ? { abandonReason: options.reason } : {}),
      });
    });
  }

  async amend(id: string, patch: AmendPlanPatch): Promise<PlanSpec> {
    return this.store.withPlanLock(id, async () => {
      const fresh = await this.require(id);
      if (!AMENDABLE.includes(fresh.status)) {
        throw new Error(
          `Plan ${id} is ${fresh.status}; only draft or executing plans can be amended.`,
        );
      }
      return this.rewrite(fresh, {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.brief !== undefined ? { brief: patch.brief } : {}),
        ...(patch.filesToTouch !== undefined ? { filesToTouch: patch.filesToTouch } : {}),
        ...(patch.testsToAdd !== undefined ? { testsToAdd: patch.testsToAdd } : {}),
        ...(patch.outOfScope !== undefined ? { outOfScope: patch.outOfScope } : {}),
        ...(patch.risks !== undefined ? { risks: patch.risks } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
      });
    });
  }

  async current(namespace: string): Promise<PlanSpec | null> {
    return this.store.findActivePlan(namespace);
  }

  private assertTransition(from: PlanStatus, to: PlanStatus): void {
    if (!TRANSITIONS[from].includes(to)) {
      throw new PlanTransitionError(from, to);
    }
  }

  private async require(id: string): Promise<PlanSpec> {
    try {
      return await this.store.readPlan(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new PlanNotFoundError(id);
      }
      throw error;
    }
  }

  /** Rewrite the plan file with a partial set of changed fields. */
  private async rewrite(plan: PlanSpec, changes: Partial<PlanSpec>): Promise<PlanSpec> {
    const next = { ...plan, ...changes };
    await this.store.writePlan({
      id: next.id,
      namespace: next.namespace,
      title: next.title,
      status: next.status,
      brief: next.brief,
      filesToTouch: next.filesToTouch,
      testsToAdd: next.testsToAdd,
      outOfScope: next.outOfScope,
      risks: next.risks,
      createdAt: next.createdAt,
      createdByAgent: next.createdByAgent,
      approvedAt: next.approvedAt,
      executingAt: next.executingAt,
      completedAt: next.completedAt,
      abandonedAt: next.abandonedAt,
      commitSha: next.commitSha,
      abandonReason: next.abandonReason,
      body: next.body,
    });
    return this.store.readPlan(next.id);
  }
}

export { ACTIVE_PLAN_STATUSES };
