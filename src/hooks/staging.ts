import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Between the edit hook and the turn-end hook, CodeBuddy needs to remember which
 * files an agent actually changed. This staging store holds that set per session
 * under `.codebuddy/cache/hooks/` (rebuildable, local, gitignored). The turn-end
 * capture hook drains it, so capture works from the *real* change set rather
 * than a summary the model may or may not write.
 */
export class HookStagingStore {
  readonly directory: string;

  constructor(repositoryRoot = process.cwd()) {
    this.directory = join(resolve(repositoryRoot), ".codebuddy", "cache", "hooks");
  }

  async add(sessionId: string, paths: string[]): Promise<void> {
    const clean = paths.map(normalize).filter(Boolean);
    if (clean.length === 0) return;
    const merged = [...new Set([...(await this.read(sessionId)), ...clean])].sort();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(this.filePath(sessionId), `${JSON.stringify({ paths: merged }, null, 2)}\n`);
  }

  async read(sessionId: string): Promise<string[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath(sessionId), "utf8"));
      return Array.isArray(parsed?.paths)
        ? parsed.paths.filter((p: unknown) => typeof p === "string")
        : [];
    } catch {
      return [];
    }
  }

  /** Return the staged paths and clear them. */
  async drain(sessionId: string): Promise<string[]> {
    const paths = await this.read(sessionId);
    await rm(this.filePath(sessionId), { force: true });
    return paths;
  }

  private filePath(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "default";
    return join(this.directory, `${safe}.json`);
  }
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}
