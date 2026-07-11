import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
  assertNoSymlinkBetween,
  composeMarkdown,
  parseFrontMatter,
  writeAtomic,
} from "./markdown-store-fs.js";

export const FACT_CATEGORIES = ["general", "incident"] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];
export const INCIDENT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

const factFrontMatterSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^fact_[a-z0-9]+$/),
  namespace: z.string().min(1),
  type: z.literal("fact"),
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  confidence: z.number().min(0).max(1),
  createdAt: z.preprocess(
    (value) => (value instanceof Date ? value.toISOString() : value),
    z.string().datetime(),
  ),
  createdByAgent: z.string().nullable(),
  sourceInteractionId: z.string().nullable(),
  sourceDeleted: z.boolean(),
  category: z.enum(FACT_CATEGORIES).default("general"),
  paths: z.array(z.string().min(1)).default([]),
  severity: z.enum(INCIDENT_SEVERITIES).nullable().default(null),
  introducedBy: z.string().nullable().default(null),
  resolvedBy: z.string().nullable().default(null),
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .default(null),
});

const summaryFrontMatterSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^sum_[a-z0-9]+$/),
  namespace: z.string().min(1),
  type: z.literal("summary"),
  sessionId: z.string().min(1),
  version: z.number().int().positive(),
  tokenCount: z.number().int().nonnegative(),
  createdAt: z.preprocess(
    (value) => (value instanceof Date ? value.toISOString() : value),
    z.string().datetime(),
  ),
  createdByAgent: z.string().nullable(),
});

export type FactFile = z.infer<typeof factFrontMatterSchema> & {
  content: string;
  path: string;
};

export type FactFileWrite = Omit<
  FactFile,
  | "path"
  | "schemaVersion"
  | "type"
  | "category"
  | "paths"
  | "severity"
  | "introducedBy"
  | "resolvedBy"
  | "fingerprint"
> &
  Partial<
    Pick<
      FactFile,
      "category" | "paths" | "severity" | "introducedBy" | "resolvedBy" | "fingerprint"
    >
  >;
export type IncidentFactFile = FactFile & {
  category: "incident";
  severity: IncidentSeverity;
};
export type SummaryFile = z.infer<typeof summaryFrontMatterSchema> & {
  content: string;
  path: string;
};
export type SummaryFileWrite = Omit<SummaryFile, "path" | "schemaVersion" | "type">;

export class MemoryFileStore {
  readonly repositoryRoot: string;
  readonly factsDirectory: string;
  readonly summariesDirectory: string;

  constructor(repositoryRoot = process.cwd()) {
    this.repositoryRoot = resolve(repositoryRoot);
    this.factsDirectory = join(this.repositoryRoot, ".codebuddy", "memory", "facts");
    this.summariesDirectory = join(this.repositoryRoot, ".codebuddy", "memory", "summaries");
  }

  async writeFact(input: FactFileWrite): Promise<string> {
    const path = this.factPath(input.id);
    await this.prepareDirectory(this.factsDirectory);
    await assertNoSymlinkBetween(this.repositoryRoot, dirname(path));

    const metadata = {
      schemaVersion: 1,
      id: input.id,
      namespace: input.namespace,
      type: "fact",
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      confidence: input.confidence,
      createdAt: input.createdAt,
      createdByAgent: input.createdByAgent,
      sourceInteractionId: input.sourceInteractionId,
      sourceDeleted: input.sourceDeleted,
      category: input.category,
      paths: input.paths,
      severity: input.severity,
      introducedBy: input.introducedBy,
      resolvedBy: input.resolvedBy,
      fingerprint: input.fingerprint,
    };
    const frontMatter = stringifyYaml(stripUndefinedAndDefaultIncidentFields(metadata));

    await writeAtomic(path, composeMarkdown(frontMatter, input.content));
    return path;
  }

  async writeSummary(input: SummaryFileWrite): Promise<string> {
    const path = this.summaryPath(input.id);
    await this.prepareDirectory(this.summariesDirectory);
    await assertNoSymlinkBetween(this.repositoryRoot, dirname(path));
    const metadata = stringifyYaml({
      schemaVersion: 1,
      id: input.id,
      namespace: input.namespace,
      type: "summary",
      sessionId: input.sessionId,
      version: input.version,
      tokenCount: input.tokenCount,
      createdAt: input.createdAt,
      createdByAgent: input.createdByAgent,
    });
    await writeAtomic(path, composeMarkdown(metadata, input.content));
    return path;
  }

  async readFact(pathOrId: string): Promise<FactFile> {
    const path = pathOrId.endsWith(".md") ? this.safePath(pathOrId) : this.factPath(pathOrId);
    await assertNoSymlinkBetween(this.repositoryRoot, path);
    const parsed = parseFrontMatter(await readFile(path, "utf8"));
    const metadata = factFrontMatterSchema.parse(parseYaml(parsed.frontMatter));
    return {
      ...metadata,
      content: parsed.content.trim(),
      path,
    };
  }

  async listFacts(): Promise<FactFile[]> {
    try {
      await this.prepareDirectory(this.factsDirectory);
      const entries = await readdir(this.factsDirectory, { withFileTypes: true });
      const facts: FactFile[] = [];
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        facts.push(await this.readFact(join(this.factsDirectory, entry.name)));
      }
      return facts;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /**
   * List incident facts for the namespace, ranked by severity then recency.
   * Unlike {@link findIncidentFactsForPaths} this does not filter by path, so
   * callers (e.g. the context engine's project bootstrap) can surface the
   * repository's incident hotspots before any specific edit target is known.
   */
  async listIncidentFacts(
    input: { namespace?: string; includeResolved?: boolean } = {},
  ): Promise<IncidentFactFile[]> {
    const incidents = (await this.listFacts()).filter((fact): fact is IncidentFactFile => {
      if (fact.category !== "incident") return false;
      if (!fact.severity) return false;
      if (input.namespace && fact.namespace !== input.namespace) return false;
      if (!input.includeResolved && fact.resolvedBy) return false;
      return true;
    });

    return incidents.sort((left, right) => {
      const severity = severityRank(right.severity) - severityRank(left.severity);
      if (severity !== 0) return severity;
      return right.createdAt.localeCompare(left.createdAt);
    });
  }

  async findIncidentFactsForPaths(input: {
    namespace?: string;
    paths: string[];
    includeResolved?: boolean;
  }): Promise<IncidentFactFile[]> {
    const wanted = new Set(input.paths.map(normalizeMemoryPath));
    if (wanted.size === 0) return [];

    return (
      await this.listIncidentFacts({
        ...(input.namespace !== undefined ? { namespace: input.namespace } : {}),
        ...(input.includeResolved !== undefined ? { includeResolved: input.includeResolved } : {}),
      })
    ).filter((fact) => fact.paths.map(normalizeMemoryPath).some((path) => wanted.has(path)));
  }

  async readSummary(pathOrId: string): Promise<SummaryFile> {
    const path = pathOrId.endsWith(".md") ? this.safePath(pathOrId) : this.summaryPath(pathOrId);
    await assertNoSymlinkBetween(this.repositoryRoot, path);
    const parsed = parseFrontMatter(await readFile(path, "utf8"));
    return {
      ...summaryFrontMatterSchema.parse(parseYaml(parsed.frontMatter)),
      content: parsed.content.trim(),
      path,
    };
  }

  async listSummaries(): Promise<SummaryFile[]> {
    try {
      await this.prepareDirectory(this.summariesDirectory);
      const entries = await readdir(this.summariesDirectory, { withFileTypes: true });
      const summaries: SummaryFile[] = [];
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        summaries.push(await this.readSummary(join(this.summariesDirectory, entry.name)));
      }
      return summaries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async deleteFact(id: string): Promise<void> {
    await rm(this.factPath(id), { force: true });
  }

  private factPath(id: string): string {
    if (!/^fact_[a-z0-9]+$/.test(id)) {
      throw new Error(`Invalid fact id: ${id}`);
    }
    return this.safePath(join(this.factsDirectory, `${id}.md`));
  }

  private summaryPath(id: string): string {
    if (!/^sum_[a-z0-9]+$/.test(id)) throw new Error(`Invalid summary id: ${id}`);
    return this.safePath(join(this.summariesDirectory, `${id}.md`));
  }

  private safePath(path: string): string {
    const absolute = resolve(path);
    const relativePath = relative(this.repositoryRoot, absolute);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativePath === "") {
      throw new Error(`Memory path escapes repository root: ${path}`);
    }
    return absolute;
  }

  private async prepareDirectory(directory: string): Promise<void> {
    await assertNoSymlinkBetween(this.repositoryRoot, dirname(directory));
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
}

function stripUndefinedAndDefaultIncidentFields(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key, value]) => {
      if (value === undefined) return false;
      if (key === "category" && value === "general") return false;
      if (key === "paths" && Array.isArray(value) && value.length === 0) return false;
      if (
        ["severity", "introducedBy", "resolvedBy"].includes(key) &&
        (value === null || value === undefined)
      ) {
        return false;
      }
      return true;
    }),
  );
}

function normalizeMemoryPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function severityRank(severity: IncidentSeverity): number {
  switch (severity) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
}
