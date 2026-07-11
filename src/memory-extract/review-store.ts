import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
  assertNoSymlinkBetween,
  composeMarkdown,
  parseFrontMatter,
  writeAtomic,
} from "../core/markdown-store-fs.js";
import { INCIDENT_SEVERITIES } from "../core/memory-file-store.js";
import { MEMORY_CLASSES } from "./types.js";

/**
 * The review queue holds memory candidates that are not safe to auto-save —
 * low confidence, sensitive content, or an inherently temporary note. Items are
 * plain Markdown with YAML front matter under `.codebuddy/memory/review/`, so
 * they are inspectable, diffable, and deletable by hand. Approving an item
 * promotes it to a durable fact; rejecting deletes it. Nothing here is ever
 * committed automatically.
 */

const reviewSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^rev_[a-z0-9]+$/),
  namespace: z.string().min(1),
  class: z.enum(MEMORY_CLASSES),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  confidence: z.number().min(0).max(1),
  paths: z.array(z.string().min(1)).default([]),
  severity: z.enum(INCIDENT_SEVERITIES).nullable().default(null),
  sensitive: z.boolean().default(false),
  sensitiveReasons: z.array(z.string()).default([]),
  reason: z.string(),
  createdAt: z.string(),
  createdByAgent: z.string().nullable(),
  sourcePlanId: z.string().nullable().default(null),
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .default(null),
  sourceSessionId: z.string().nullable().default(null),
  verification: z.array(z.string()).default([]),
});

export type ReviewItemWrite = Omit<
  z.infer<typeof reviewSchema>,
  "schemaVersion" | "fingerprint" | "sourceSessionId" | "verification"
> & {
  fingerprint?: string | null;
  sourceSessionId?: string | null;
  verification?: string[];
  content: string;
};
export type ReviewItem = z.infer<typeof reviewSchema> & { content: string; path: string };

export class ReviewStore {
  readonly repositoryRoot: string;
  readonly reviewDirectory: string;
  readonly archiveDirectory: string;

  constructor(repositoryRoot = process.cwd()) {
    this.repositoryRoot = resolve(repositoryRoot);
    this.reviewDirectory = join(this.repositoryRoot, ".codebuddy", "memory", "review");
    this.archiveDirectory = join(this.repositoryRoot, ".codebuddy", "memory", "review-archive");
  }

  async write(input: ReviewItemWrite): Promise<string> {
    const path = this.itemPath(input.id);
    await this.prepareDirectory();
    await assertNoSymlinkBetween(this.repositoryRoot, dirname(path));
    const frontMatter = stringifyYaml({
      schemaVersion: 1,
      id: input.id,
      namespace: input.namespace,
      class: input.class,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      confidence: input.confidence,
      paths: input.paths,
      severity: input.severity,
      sensitive: input.sensitive,
      sensitiveReasons: input.sensitiveReasons,
      reason: input.reason,
      createdAt: input.createdAt,
      createdByAgent: input.createdByAgent,
      sourcePlanId: input.sourcePlanId,
      fingerprint: input.fingerprint,
      sourceSessionId: input.sourceSessionId,
      verification: input.verification,
    });
    await writeAtomic(path, composeMarkdown(frontMatter, input.content));
    return path;
  }

  async read(id: string): Promise<ReviewItem> {
    const path = this.itemPath(id);
    await assertNoSymlinkBetween(this.repositoryRoot, path);
    const parsed = parseFrontMatter(await readFile(path, "utf8"));
    return {
      ...reviewSchema.parse(parseYaml(parsed.frontMatter)),
      content: parsed.content.trim(),
      path,
    };
  }

  async list(): Promise<ReviewItem[]> {
    try {
      await this.prepareDirectory();
      const entries = await readdir(this.reviewDirectory, { withFileTypes: true });
      const items: ReviewItem[] = [];
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        items.push(await this.read(entry.name.replace(/\.md$/, "")));
      }
      return items;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    await rm(this.itemPath(id), { force: true });
  }

  async archiveExpired(options: { olderThanDays?: number; now?: Date } = {}): Promise<number> {
    const cutoff =
      (options.now ?? new Date()).getTime() - (options.olderThanDays ?? 30) * 24 * 60 * 60 * 1000;
    const items = await this.list();
    let archived = 0;
    for (const item of items) {
      if (Date.parse(item.createdAt) >= cutoff) continue;
      await this.archive(item);
      archived++;
    }
    return archived;
  }

  async enforceLimit(maxItems = 500): Promise<number> {
    const items = (await this.list()).sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    const overflow = Math.max(0, items.length - maxItems);
    for (const item of items.slice(0, overflow)) await this.archive(item);
    return overflow;
  }

  private async archive(item: ReviewItem): Promise<void> {
    await mkdir(this.archiveDirectory, { recursive: true, mode: 0o700 });
    await assertNoSymlinkBetween(this.repositoryRoot, this.archiveDirectory);
    await rename(item.path, join(this.archiveDirectory, `${item.id}.md`));
  }

  private itemPath(id: string): string {
    if (!/^rev_[a-z0-9]+$/.test(id)) throw new Error(`Invalid review id: ${id}`);
    return this.safePath(join(this.reviewDirectory, `${id}.md`));
  }

  private safePath(path: string): string {
    const absolute = resolve(path);
    const relativePath = relative(this.repositoryRoot, absolute);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativePath === "") {
      throw new Error(`Review path escapes repository root: ${path}`);
    }
    return absolute;
  }

  private async prepareDirectory(): Promise<void> {
    await assertNoSymlinkBetween(this.repositoryRoot, dirname(this.reviewDirectory));
    await mkdir(this.reviewDirectory, { recursive: true, mode: 0o700 });
  }
}
