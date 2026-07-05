import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { assertNoSymlinkBetween, writeAtomic } from "../core/markdown-store-fs.js";
import { INDEX_MANIFEST_VERSION, type IndexManifest } from "./types.js";

/**
 * Persists the index manifest as a single JSON file under
 * `.codebuddy/cache/index.json`. `cache/` is gitignored by the project
 * scaffold, so the manifest is treated as a rebuildable derived artifact —
 * corrupt or version-mismatched manifests degrade to "empty" rather than
 * throwing, and a full `codebuddy index` regenerates them.
 */

const symbolSpanSchema = z.object({
  name: z.string(),
  kind: z.enum(["function", "class", "interface", "type", "enum", "const"]),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  signature: z.string(),
  exported: z.boolean(),
});

const entrySchema = z.object({
  path: z.string(),
  hash: z.string(),
  size: z.number().int().nonnegative(),
  language: z.string(),
  lines: z.number().int().nonnegative(),
  symbols: z.array(z.string()),
  symbolTable: z.array(symbolSpanSchema).optional(),
  summary: z.string(),
  indexedAt: z.string(),
});

const manifestSchema = z.object({
  version: z.literal(INDEX_MANIFEST_VERSION),
  generatedAt: z.string(),
  entries: z.record(z.string(), entrySchema),
});

export class IndexStore {
  readonly repositoryRoot: string;
  readonly cacheDirectory: string;
  readonly manifestPath: string;

  constructor(repositoryRoot = process.cwd()) {
    this.repositoryRoot = resolve(repositoryRoot);
    this.cacheDirectory = join(this.repositoryRoot, ".codebuddy", "cache");
    this.manifestPath = join(this.cacheDirectory, "index.json");
  }

  /** Read the manifest, or an empty one if absent/corrupt/version-mismatched. */
  async read(): Promise<IndexManifest> {
    try {
      const raw = await readFile(this.manifestPath, "utf8");
      const parsed = manifestSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return emptyManifest();
      // Zod's optional() widens to `| undefined`; the parse guarantees the shape.
      return parsed.data as IndexManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyManifest();
      // Unreadable cache is non-fatal: rebuild from scratch.
      return emptyManifest();
    }
  }

  async write(manifest: IndexManifest): Promise<void> {
    await assertNoSymlinkBetween(this.repositoryRoot, dirname(this.manifestPath));
    await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
    await writeAtomic(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

export function emptyManifest(): IndexManifest {
  return { version: INDEX_MANIFEST_VERSION, generatedAt: new Date(0).toISOString(), entries: {} };
}
