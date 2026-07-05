import { mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
  assertNoSymlinkBetween,
  composeMarkdown,
  parseFrontMatter,
  writeAtomic,
} from "./markdown-store-fs.js";

/**
 * Plans are durable Markdown artifacts under `.codebuddy/plans/`. Git is
 * the version history; PostgreSQL (when present) is a derived index, never
 * the source of truth. This store owns the on-disk representation:
 * schema, round-trip serialization, atomic writes, and the locks that keep
 * concurrent CLI/MCP clients from corrupting a plan or approving two active
 * plans in one namespace.
 */

export const PLAN_STATUSES = ["draft", "approved", "executing", "complete", "abandoned"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** A plan is "active" while approved or executing — at most one per namespace. */
export const ACTIVE_PLAN_STATUSES: readonly PlanStatus[] = ["approved", "executing"];

const plannedFileSchema = z.object({
  path: z.string().min(1),
  action: z.enum(["create", "edit", "delete"]),
  notes: z.string().default(""),
});

const plannedTestSchema = z.object({
  path: z.string().min(1),
  description: z.string().default(""),
});

const nullableDateTime = z
  .preprocess(
    (value) => (value instanceof Date ? value.toISOString() : value),
    z.string().datetime().nullable(),
  )
  .nullable();

const planFrontMatterSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^pln_[a-z0-9]+$/),
  namespace: z.string().min(1),
  type: z.literal("plan"),
  title: z.string().min(1),
  status: z.enum(PLAN_STATUSES),
  brief: z.string(),
  filesToTouch: z.array(plannedFileSchema).default([]),
  testsToAdd: z.array(plannedTestSchema).default([]),
  outOfScope: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  createdAt: z.preprocess(
    (value) => (value instanceof Date ? value.toISOString() : value),
    z.string().datetime(),
  ),
  createdByAgent: z.string().nullable(),
  approvedAt: nullableDateTime,
  executingAt: nullableDateTime,
  completedAt: nullableDateTime,
  abandonedAt: nullableDateTime,
  commitSha: z.string().nullable(),
  abandonReason: z.string().nullable(),
});

export type PlannedFile = z.infer<typeof plannedFileSchema>;
export type PlannedTest = z.infer<typeof plannedTestSchema>;
export type PlanFrontMatter = z.infer<typeof planFrontMatterSchema>;

/** A fully materialized plan: front matter + Markdown body + on-disk path. */
export type PlanSpec = PlanFrontMatter & {
  body: string;
  path: string;
};

/** Shape accepted by `writePlan` — path/schemaVersion/type are managed here. */
export type PlanWrite = Omit<PlanFrontMatter, "schemaVersion" | "type"> & {
  body: string;
};

export type PlanLockOptions = {
  /** Max time to wait for the lock before failing. */
  timeoutMs?: number;
  /** A lock older than this is considered abandoned and stolen. */
  staleMs?: number;
  /** Poll interval while waiting. */
  pollMs?: number;
};

export class PlanLockError extends Error {
  constructor(resource: string) {
    super(
      `Could not acquire lock for ${resource} within the timeout. Another client may be holding it.`,
    );
    this.name = "PlanLockError";
  }
}

export class PlanValidationError extends Error {
  constructor(path: string, issues: string[]) {
    super(`Invalid plan file ${path}:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "PlanValidationError";
  }
}

const DEFAULT_LOCK: Required<PlanLockOptions> = {
  timeoutMs: 5_000,
  staleMs: 30_000,
  pollMs: 50,
};

export class PlanFileStore {
  readonly repositoryRoot: string;
  readonly plansDirectory: string;
  readonly locksDirectory: string;

  constructor(repositoryRoot = process.cwd()) {
    this.repositoryRoot = resolve(repositoryRoot);
    this.plansDirectory = join(this.repositoryRoot, ".codebuddy", "plans");
    this.locksDirectory = join(this.plansDirectory, ".locks");
  }

  // ── Read / write ────────────────────────────────────────────────────

  async writePlan(input: PlanWrite): Promise<string> {
    const path = this.planPath(input.id);
    await this.prepareDirectory(this.plansDirectory);
    await assertNoSymlinkBetween(this.repositoryRoot, dirname(path));

    const frontMatter = stringifyYaml({
      schemaVersion: 1,
      id: input.id,
      namespace: input.namespace,
      type: "plan",
      title: input.title,
      status: input.status,
      brief: input.brief,
      filesToTouch: input.filesToTouch,
      testsToAdd: input.testsToAdd,
      outOfScope: input.outOfScope,
      risks: input.risks,
      createdAt: input.createdAt,
      createdByAgent: input.createdByAgent,
      approvedAt: input.approvedAt,
      executingAt: input.executingAt,
      completedAt: input.completedAt,
      abandonedAt: input.abandonedAt,
      commitSha: input.commitSha,
      abandonReason: input.abandonReason,
    });

    await writeAtomic(path, composeMarkdown(frontMatter, input.body));
    return path;
  }

  async readPlan(pathOrId: string): Promise<PlanSpec> {
    const path = pathOrId.endsWith(".md") ? this.safePath(pathOrId) : this.planPath(pathOrId);
    await assertNoSymlinkBetween(this.repositoryRoot, path);
    const parsed = parseFrontMatter(await readFile(path, "utf8"));
    const result = planFrontMatterSchema.safeParse(parseYaml(parsed.frontMatter));
    if (!result.success) {
      throw new PlanValidationError(path, formatIssues(result.error));
    }
    return { ...result.data, body: parsed.content.trim(), path };
  }

  async listPlans(): Promise<PlanSpec[]> {
    try {
      await this.prepareDirectory(this.plansDirectory);
      const entries = await readdir(this.plansDirectory, { withFileTypes: true });
      const plans: PlanSpec[] = [];
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        // Plans are always written as `<pln_id>.md`. Ignore any other markdown
        // (hand-written notes, READMEs, build plans) so a shared plans dir with
        // non-plan files can't make discovery throw.
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        if (!/^pln_[a-z0-9]+\.md$/.test(entry.name)) continue;
        plans.push(await this.readPlan(join(this.plansDirectory, entry.name)));
      }
      return plans;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async deletePlan(id: string): Promise<void> {
    await rm(this.planPath(id), { force: true });
  }

  /**
   * The single approved-or-executing plan in `namespace`, or null. If the
   * filesystem somehow holds more than one (a hand edit, a crash mid-
   * transition), the earliest-created wins and the situation is the
   * caller's to reconcile.
   */
  async findActivePlan(namespace: string): Promise<PlanSpec | null> {
    const active = (await this.listPlans()).filter(
      (plan) => plan.namespace === namespace && ACTIVE_PLAN_STATUSES.includes(plan.status),
    );
    if (active.length === 0) return null;
    active.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return active[0] ?? null;
  }

  // ── Locking ─────────────────────────────────────────────────────────

  /** Serialize amendments to a single plan. */
  async withPlanLock<T>(id: string, fn: () => Promise<T>, options?: PlanLockOptions): Promise<T> {
    this.assertPlanId(id);
    return this.withLock(`${id}.lock`, id, fn, options);
  }

  /**
   * Serialize lifecycle transitions across an entire namespace so two
   * clients cannot both promote a plan to active. Hold this around the
   * read-active-then-write window.
   */
  async withNamespaceLock<T>(
    namespace: string,
    fn: () => Promise<T>,
    options?: PlanLockOptions,
  ): Promise<T> {
    const safeName = namespace.replace(/[^a-zA-Z0-9_.:-]/g, "-");
    return this.withLock(`namespace_${safeName}.lock`, `namespace ${namespace}`, fn, options);
  }

  private async withLock<T>(
    lockFileName: string,
    resourceLabel: string,
    fn: () => Promise<T>,
    options?: PlanLockOptions,
  ): Promise<T> {
    const config = { ...DEFAULT_LOCK, ...options };
    await this.prepareDirectory(this.locksDirectory);
    const lockPath = join(this.locksDirectory, lockFileName);
    const deadline = Date.now() + config.timeoutMs;

    for (;;) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.tryStealStaleLock(lockPath, config.staleMs)) continue;
        if (Date.now() >= deadline) throw new PlanLockError(resourceLabel);
        await delay(config.pollMs);
      }
    }

    try {
      return await fn();
    } finally {
      await rm(lockPath, { force: true });
    }
  }

  private async tryStealStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
    try {
      const info = await stat(lockPath);
      if (Date.now() - info.mtimeMs > staleMs) {
        await rm(lockPath, { force: true });
        return true;
      }
    } catch (error) {
      // Lock vanished between EEXIST and stat — treat as free, retry.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    return false;
  }

  // ── Paths ───────────────────────────────────────────────────────────

  private planPath(id: string): string {
    this.assertPlanId(id);
    return this.safePath(join(this.plansDirectory, `${id}.md`));
  }

  private assertPlanId(id: string): void {
    if (!/^pln_[a-z0-9]+$/.test(id)) {
      throw new Error(`Invalid plan id: ${id}`);
    }
  }

  private safePath(path: string): string {
    const absolute = resolve(path);
    const relativePath = relative(this.repositoryRoot, absolute);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativePath === "") {
      throw new Error(`Plan path escapes repository root: ${path}`);
    }
    return absolute;
  }

  private async prepareDirectory(directory: string): Promise<void> {
    await assertNoSymlinkBetween(this.repositoryRoot, dirname(directory));
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
