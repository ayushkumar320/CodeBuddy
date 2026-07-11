import { mkdir, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { assertNoSymlinkBetween, writeAtomic } from "../core/markdown-store-fs.js";
import { IndexStore } from "../indexer/store.js";
import type { IndexManifest } from "../indexer/types.js";
import {
  buildArchitectureMap,
  type IncrementalMapStats,
  updateArchitectureMap,
} from "./indexer.js";
import type { ArchitectureMap } from "./types.js";

const CACHE_VERSION = 1;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

type ArchitectureCache = {
  version: 1;
  generatedAt: string;
  sourceHashes: Record<string, string>;
  map: ArchitectureMap;
};

export type CachedArchitectureResult = {
  map: ArchitectureMap;
  stats: IncrementalMapStats;
  source: "cache" | "incremental" | "rebuild" | "fallback";
};

export async function loadArchitectureMap(
  repositoryRoot = process.cwd(),
  suppliedManifest?: IndexManifest,
): Promise<CachedArchitectureResult> {
  const root = resolve(repositoryRoot);
  const manifest = suppliedManifest ?? (await new IndexStore(root).read());
  if (Object.keys(manifest.entries).length === 0) {
    const map = await buildArchitectureMap(root);
    return {
      map,
      stats: { readFiles: map.modules.length, reusedFiles: 0, rebuilt: true },
      source: "fallback",
    };
  }
  return refreshArchitectureCache(root, manifest);
}

export async function refreshArchitectureCache(
  repositoryRoot: string,
  manifest: IndexManifest,
): Promise<CachedArchitectureResult> {
  const root = resolve(repositoryRoot);
  const path = join(root, ".codebuddy", "cache", "architecture.json");
  const currentHashes = sourceHashes(manifest);
  const currentPaths = Object.keys(currentHashes).sort();
  const cached = await readCache(path);
  const cachedPaths = cached ? Object.keys(cached.sourceHashes).sort() : [];
  const fileSetChanged = cachedPaths.join("\n") !== currentPaths.join("\n");
  const changedPaths =
    !cached || fileSetChanged
      ? currentPaths
      : currentPaths.filter(
          (sourcePath) => cached.sourceHashes[sourcePath] !== currentHashes[sourcePath],
        );

  if (cached && changedPaths.length === 0) {
    return {
      map: cached.map,
      stats: { readFiles: 0, reusedFiles: cached.map.modules.length, rebuilt: false },
      source: "cache",
    };
  }

  const updated = await updateArchitectureMap(
    root,
    currentPaths,
    fileSetChanged ? null : (cached?.map ?? null),
    changedPaths,
  );
  const next: ArchitectureCache = {
    version: CACHE_VERSION,
    generatedAt: manifest.generatedAt,
    sourceHashes: currentHashes,
    map: updated.map,
  };
  await assertNoSymlinkBetween(root, dirname(path));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  return { ...updated, source: fileSetChanged || !cached ? "rebuild" : "incremental" };
}

async function readCache(path: string): Promise<ArchitectureCache | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ArchitectureCache;
    if (parsed.version !== CACHE_VERSION || !parsed.map || !parsed.sourceHashes) return null;
    if (!Array.isArray(parsed.map.modules) || !Array.isArray(parsed.map.edges)) return null;
    if (
      !parsed.map.modules.every(
        (module) =>
          module &&
          typeof module.path === "string" &&
          typeof module.language === "string" &&
          Array.isArray(module.imports),
      ) ||
      !parsed.map.edges.every(
        (edge) => edge && typeof edge.from === "string" && typeof edge.to === "string",
      )
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function sourceHashes(manifest: IndexManifest): Record<string, string> {
  return Object.fromEntries(
    Object.values(manifest.entries)
      .filter((entry) => SOURCE_EXTENSIONS.has(extname(entry.path).toLowerCase()))
      .map((entry) => [entry.path, entry.hash]),
  );
}
