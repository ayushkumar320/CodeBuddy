import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { listIndexableFiles } from "./scan.js";
import { IndexStore } from "./store.js";
import { summarizeSource } from "./summary.js";
import { extractSymbolTable, supportsSymbols } from "./symbols.js";
import {
  INDEX_MANIFEST_VERSION,
  type IndexEntry,
  type IndexError,
  type IndexManifest,
  type IndexResult,
} from "./types.js";

/**
 * Incremental repository indexing. A file is re-summarized only when its
 * content hash differs from the manifest, so repeated runs over an unchanged
 * tree are cheap and deterministic. Per-file failures (unreadable, too large)
 * are isolated and reported; they never abort the pass. `full` ignores existing
 * hashes and rebuilds every entry.
 */

/** Skip files larger than this — summarizing them is neither cheap nor useful. */
const MAX_FILE_BYTES = 512_000;

export type IndexOptions = {
  repositoryRoot?: string;
  full?: boolean;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
};

export async function indexRepository(options: IndexOptions = {}): Promise<IndexResult> {
  const start = Date.now();
  const now = options.now ?? (() => new Date());
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const store = new IndexStore(repositoryRoot);

  const [files, previous] = await Promise.all([listIndexableFiles(repositoryRoot), store.read()]);

  const entries: Record<string, IndexEntry> = {};
  const errors: IndexError[] = [];
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const path of files) {
    try {
      const info = await stat(join(repositoryRoot, path));
      if (!info.isFile()) continue;
      if (info.size > MAX_FILE_BYTES) {
        skipped++;
        continue;
      }

      const content = await readFile(join(repositoryRoot, path), "utf8");
      const hash = hashContent(content);
      const existing = previous.entries[path];

      if (!options.full && existing && existing.hash === hash) {
        entries[path] = existing;
        unchanged++;
        continue;
      }

      const { language, lines, symbols, summary } = summarizeSource(path, content);
      const symbolTable = supportsSymbols(path) ? extractSymbolTable(content) : [];
      entries[path] = {
        path,
        hash,
        size: info.size,
        language,
        lines,
        symbols,
        ...(symbolTable.length > 0 ? { symbolTable } : {}),
        summary,
        indexedAt: now().toISOString(),
      };
      if (existing) changed++;
      else added++;
    } catch (error) {
      errors.push({ path, error: (error as Error).message });
      skipped++;
    }
  }

  const removed = Object.keys(previous.entries).filter((path) => !(path in entries)).length;

  const manifest: IndexManifest = {
    version: INDEX_MANIFEST_VERSION,
    generatedAt: now().toISOString(),
    entries: sortEntries(entries),
  };
  await store.write(manifest);

  return {
    scanned: files.length,
    added,
    changed,
    unchanged,
    removed,
    skipped,
    errors,
    durationMs: Date.now() - start,
    totalIndexed: Object.keys(entries).length,
  };
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function sortEntries(entries: Record<string, IndexEntry>): Record<string, IndexEntry> {
  return Object.fromEntries(
    Object.keys(entries)
      .sort()
      .map((key) => [key, entries[key] as IndexEntry]),
  );
}
