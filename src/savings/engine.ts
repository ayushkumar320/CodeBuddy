import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IndexStore } from "../indexer/store.js";
import { summarizeSource } from "../indexer/summary.js";
import type { IndexManifest } from "../indexer/types.js";
import { buildProjectSummary } from "./summaries.js";
import { estimateTokens } from "./tokens.js";
import type { FileCapsule, RepoSavings, SavingsStats, StageStat } from "./types.js";

/**
 * The savings engine measures compact context against a concrete baseline: the
 * cost of reading the represented files' raw source. It prefers the index
 * manifest (Phase 04.3) for sizes and summaries, and falls back to reading the
 * file when the manifest has no entry — so savings work even before a full
 * `codebuddy index`. Savings are clamped to never go negative and never claim
 * more than the baseline: no fake numbers.
 */

const MAX_FALLBACK_BYTES = 512_000;

type FileInfo = { size: number; summary: string; symbols: string[] };

export type ComputeSavingsInput = {
  repositoryRoot?: string;
  representedPaths: string[];
  returnedTokens: number;
  budget: number;
  stages?: StageStat[];
};

export type ComputeSavingsResult = {
  stats: SavingsStats;
  capsules: FileCapsule[];
};

export async function computeSavings(input: ComputeSavingsInput): Promise<ComputeSavingsResult> {
  const repositoryRoot = resolve(input.repositoryRoot ?? process.cwd());
  const manifest = await new IndexStore(repositoryRoot).read();
  const uniquePaths = [...new Set(input.representedPaths)].sort();

  const capsules: FileCapsule[] = [];
  for (const path of uniquePaths) {
    const info = await resolveFileInfo(repositoryRoot, path, manifest);
    if (!info) continue;
    capsules.push(toCapsule(path, info));
  }

  const baselineTokens = sum(capsules.map((capsule) => capsule.rawTokens));
  const stats = summarize({
    budget: input.budget,
    baselineTokens,
    returnedTokens: input.returnedTokens,
    representedFiles: capsules.length,
    stages: input.stages ?? [],
  });
  return { stats, capsules };
}

/** Repo-wide savings from the index manifest, for `codebuddy savings`. */
export async function computeRepoSavings(repositoryRoot = process.cwd()): Promise<RepoSavings> {
  const root = resolve(repositoryRoot);
  const manifest = await new IndexStore(root).read();
  const entries = Object.values(manifest.entries);
  const project = buildProjectSummary(manifest);

  if (entries.length === 0) {
    return {
      project,
      savings: {
        available: false,
        budget: 0,
        baselineTokens: 0,
        returnedTokens: 0,
        savedTokens: 0,
        compressionRatio: 1,
        withinBudget: true,
        representedFiles: 0,
        stages: [],
        note: "No index found. Run `codebuddy index` to measure savings.",
      },
    };
  }

  const capsules = entries.map((entry) =>
    toCapsule(entry.path, { size: entry.size, summary: entry.summary, symbols: entry.symbols }),
  );
  const baselineTokens = sum(capsules.map((capsule) => capsule.rawTokens));
  const returnedTokens = sum(capsules.map((capsule) => capsule.summaryTokens));
  return {
    project,
    savings: summarize({
      budget: 0,
      baselineTokens,
      returnedTokens,
      representedFiles: capsules.length,
      stages: [{ stage: "summaries", returnedTokens }],
    }),
  };
}

export function toCapsule(path: string, info: FileInfo): FileCapsule {
  const rawTokens = Math.ceil(info.size / 4);
  const summaryTokens = estimateTokens(`${info.summary} ${info.symbols.join(" ")}`);
  return {
    id: capsuleId(path, info.summary),
    path,
    summary: info.summary,
    symbols: info.symbols,
    rawTokens,
    summaryTokens,
    savedTokens: Math.max(0, rawTokens - summaryTokens),
  };
}

function summarize(input: {
  budget: number;
  baselineTokens: number;
  returnedTokens: number;
  representedFiles: number;
  stages: StageStat[];
}): SavingsStats {
  const { baselineTokens, returnedTokens, budget } = input;
  return {
    available: baselineTokens > 0,
    budget,
    baselineTokens,
    returnedTokens,
    savedTokens: Math.max(0, baselineTokens - returnedTokens),
    compressionRatio: baselineTokens > 0 ? Math.min(1, returnedTokens / baselineTokens) : 1,
    withinBudget: budget <= 0 ? true : returnedTokens <= budget,
    representedFiles: input.representedFiles,
    stages: input.stages,
    ...(baselineTokens > 0 ? {} : { note: "No represented files to measure against." }),
  };
}

async function resolveFileInfo(
  repositoryRoot: string,
  path: string,
  manifest: IndexManifest,
): Promise<FileInfo | null> {
  const entry = manifest.entries[path];
  if (entry) return { size: entry.size, summary: entry.summary, symbols: entry.symbols };

  // Not indexed yet: derive on the fly so savings still work pre-index.
  try {
    const info = await stat(join(repositoryRoot, path));
    if (!info.isFile()) return null;
    if (info.size > MAX_FALLBACK_BYTES) {
      return { size: info.size, summary: "large file (not summarized)", symbols: [] };
    }
    const content = await readFile(join(repositoryRoot, path), "utf8");
    const summary = summarizeSource(path, content);
    return { size: info.size, summary: summary.summary, symbols: summary.symbols };
  } catch {
    return null;
  }
}

function capsuleId(path: string, summary: string): string {
  return createHash("sha256").update(`${path}\n${summary}`).digest("hex").slice(0, 16);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
