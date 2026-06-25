import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

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

export type FactFileWrite = Omit<FactFile, "path" | "schemaVersion" | "type">;
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

    const frontMatter = stringifyYaml({
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
    }).trimEnd();
    const content = input.content.endsWith("\n") ? input.content : `${input.content}\n`;
    const document = `---\n${frontMatter}\n---\n${content}`;

    await writeAtomic(path, document);
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
    }).trimEnd();
    const content = input.content.endsWith("\n") ? input.content : `${input.content}\n`;
    await writeAtomic(path, `---\n${metadata}\n---\n${content}`);
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

async function writeAtomic(path: string, document: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(document, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
}

function parseFrontMatter(document: string): { frontMatter: string; content: string } {
  if (!document.startsWith("---\n")) {
    throw new Error("Memory file must start with YAML front matter.");
  }
  const closingIndex = document.indexOf("\n---\n", 4);
  if (closingIndex === -1) {
    throw new Error("Memory file has unterminated YAML front matter.");
  }
  return {
    frontMatter: document.slice(4, closingIndex),
    content: document.slice(closingIndex + 5),
  };
}

async function assertNoSymlinkBetween(root: string, target: string): Promise<void> {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  const relativeTarget = relative(absoluteRoot, absoluteTarget);
  if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
    throw new Error(`Memory path escapes repository root: ${target}`);
  }

  let current = absoluteRoot;
  const parts = relativeTarget.split(sep).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error(`Refusing to use symlinked memory path: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}
