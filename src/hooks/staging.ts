import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeAtomic } from "../core/markdown-store-fs.js";

/**
 * Between the edit hook and the turn-end hook, CodeBuddy needs to remember which
 * files an agent actually changed. This staging store holds that set per session
 * under `.codebuddy/cache/hooks/` (rebuildable, local, gitignored). The turn-end
 * capture hook drains it, so capture works from the *real* change set rather
 * than a summary the model may or may not write.
 */
export class HookStagingStore {
  readonly directory: string;
  private operations = Promise.resolve();

  constructor(repositoryRoot = process.cwd()) {
    this.directory = join(resolve(repositoryRoot), ".codebuddy", "cache", "hooks");
  }

  async add(sessionId: string, paths: string[]): Promise<void> {
    await this.serialize(async () => {
      const clean = paths.map(normalize).filter(Boolean);
      if (clean.length === 0) return;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.withFileLock(sessionId, async () => {
        const merged = [...new Set([...(await this.read(sessionId)), ...clean])].sort();
        await writeAtomic(
          this.filePath(sessionId),
          `${JSON.stringify({ paths: merged }, null, 2)}\n`,
        );
      });
    });
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
    return this.serialize(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      return this.withFileLock(sessionId, async () => {
        const path = this.filePath(sessionId);
        const draining = `${path}.${process.pid}.${Date.now()}.drain`;
        try {
          await rename(path, draining);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
        try {
          const parsed = JSON.parse(await readFile(draining, "utf8"));
          return Array.isArray(parsed?.paths)
            ? parsed.paths.filter((item: unknown) => typeof item === "string")
            : [];
        } finally {
          await rm(draining, { force: true });
        }
      });
    });
  }

  private async withFileLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const lock = `${this.filePath(sessionId)}.lock`;
    for (let attempt = 0; ; attempt++) {
      try {
        await mkdir(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 200) throw error;
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operations;
    let release!: () => void;
    this.operations = new Promise<void>((resolveOperation) => {
      release = resolveOperation;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private filePath(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "default";
    return join(this.directory, `${safe}.json`);
  }
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}
