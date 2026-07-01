import { describe, expect, it } from "vitest";
import type { IndexEntry, IndexManifest } from "../indexer/types.js";
import { buildDirectorySummaries, buildProjectSummary } from "./summaries.js";

function entry(path: string, overrides: Partial<IndexEntry> = {}): IndexEntry {
  return {
    path,
    hash: "h",
    size: 100,
    language: "ts",
    lines: 10,
    symbols: [],
    summary: "ts • 10 lines",
    indexedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function manifest(entries: IndexEntry[]): IndexManifest {
  return {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    entries: Object.fromEntries(entries.map((e) => [e.path, e])),
  };
}

describe("buildProjectSummary", () => {
  it("aggregates files, lines, languages, and top directories", () => {
    const summary = buildProjectSummary(
      manifest([
        entry("src/a.ts", { lines: 10, symbols: ["a"] }),
        entry("src/b.ts", { lines: 20 }),
        entry("README.md", { language: "md", lines: 5 }),
      ]),
    );
    expect(summary.files).toBe(3);
    expect(summary.lines).toBe(35);
    expect(summary.languages).toEqual({ ts: 2, md: 1 });
    const src = summary.topDirectories.find((d) => d.directory === "src");
    expect(src?.files).toBe(2);
    expect(src?.symbols).toContain("a");
  });
});

describe("buildDirectorySummaries", () => {
  it("groups files by their immediate parent directory", () => {
    const summaries = buildDirectorySummaries(
      manifest([entry("src/auth/a.ts"), entry("src/auth/b.ts"), entry("src/map/c.ts")]),
    );
    const auth = summaries.find((s) => s.directory === "src/auth");
    expect(auth?.files).toBe(2);
    expect(summaries.map((s) => s.directory)).toContain("src/map");
  });
});
