import type { IndexEntry, IndexManifest } from "../indexer/types.js";
import type { DirectorySummary, ProjectSummary } from "./types.js";

/**
 * Hierarchical summaries rolled up from the file-level index manifest:
 * directory summaries aggregate the files beneath them, and the project summary
 * aggregates the whole tree. These are the coarse-grained context layers an
 * agent can lean on instead of reading every file — file → directory → project.
 */

const TOP_DIRECTORY_LIMIT = 8;
const DIRECTORY_SYMBOL_LIMIT = 12;

export function buildProjectSummary(manifest: IndexManifest): ProjectSummary {
  const entries = Object.values(manifest.entries);
  const byTopDirectory = new Map<string, IndexEntry[]>();
  for (const entry of entries) {
    const top = topSegment(entry.path);
    const bucket = byTopDirectory.get(top);
    if (bucket) bucket.push(entry);
    else byTopDirectory.set(top, [entry]);
  }

  const topDirectories = [...byTopDirectory.entries()]
    .map(([directory, dirEntries]) => summarizeGroup(directory, dirEntries))
    .sort(
      (left, right) => right.files - left.files || left.directory.localeCompare(right.directory),
    )
    .slice(0, TOP_DIRECTORY_LIMIT);

  return {
    files: entries.length,
    lines: sum(entries.map((entry) => entry.lines)),
    languages: countLanguages(entries),
    topDirectories,
  };
}

/** Directory summaries keyed by each file's immediate parent directory. */
export function buildDirectorySummaries(manifest: IndexManifest): DirectorySummary[] {
  const byDirectory = new Map<string, IndexEntry[]>();
  for (const entry of Object.values(manifest.entries)) {
    const directory = parentDirectory(entry.path);
    const bucket = byDirectory.get(directory);
    if (bucket) bucket.push(entry);
    else byDirectory.set(directory, [entry]);
  }
  return [...byDirectory.entries()]
    .map(([directory, entries]) => summarizeGroup(directory, entries))
    .sort((left, right) => left.directory.localeCompare(right.directory));
}

function summarizeGroup(directory: string, entries: IndexEntry[]): DirectorySummary {
  const symbols: string[] = [];
  for (const entry of entries) {
    for (const symbol of entry.symbols) {
      if (symbols.length >= DIRECTORY_SYMBOL_LIMIT) break;
      if (!symbols.includes(symbol)) symbols.push(symbol);
    }
  }
  return {
    directory,
    files: entries.length,
    lines: sum(entries.map((entry) => entry.lines)),
    languages: countLanguages(entries),
    symbols,
  };
}

function countLanguages(entries: IndexEntry[]): Record<string, number> {
  const languages: Record<string, number> = {};
  for (const entry of entries) languages[entry.language] = (languages[entry.language] ?? 0) + 1;
  return Object.fromEntries(Object.entries(languages).sort((left, right) => right[1] - left[1]));
}

function topSegment(path: string): string {
  const index = path.indexOf("/");
  return index === -1 ? "." : path.slice(0, index);
}

function parentDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
