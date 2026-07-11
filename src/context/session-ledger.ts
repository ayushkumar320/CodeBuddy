import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeAtomic } from "../core/markdown-store-fs.js";
import { estimateTokens } from "../savings/tokens.js";

const VERSION = 1;
const MAX_CAPSULES = 128;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type LedgerRecord = { hash: string; lastSentAt: string };
type LedgerFile = { version: 1; updatedAt: string; records: Record<string, LedgerRecord> };

export type ContextCapsule = { key: string; text: string };
export type CapsuleDelivery = {
  lines: string[];
  full: number;
  referenced: number;
  sentTokens: number;
  avoidedTokens: number;
};

export class SessionCapsuleLedger {
  private readonly directory: string;

  constructor(repositoryRoot = process.cwd()) {
    this.directory = join(resolve(repositoryRoot), ".codebuddy", "cache", "session");
  }

  async deliver(
    sessionId: string,
    capsules: ContextCapsule[],
    now = new Date(),
  ): Promise<CapsuleDelivery> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const release = await this.acquire(sessionId);
    try {
      const path = this.path(sessionId);
      const ledger = await this.read(path, now);
      const lines: string[] = [];
      let full = 0;
      let referenced = 0;
      let sentTokens = 0;
      let avoidedTokens = 0;

      for (const capsule of capsules) {
        const hash = digest(capsule.text);
        const existing = ledger.records[capsule.key];
        if (existing?.hash === hash) {
          const reference = `capsule:${hash.slice(0, 8)}`;
          lines.push(reference);
          referenced++;
          sentTokens += estimateTokens(reference);
          avoidedTokens += Math.max(0, estimateTokens(capsule.text) - estimateTokens(reference));
        } else {
          lines.push(capsule.text);
          full++;
          sentTokens += estimateTokens(capsule.text);
        }
        ledger.records[capsule.key] = { hash, lastSentAt: now.toISOString() };
      }

      ledger.updatedAt = now.toISOString();
      ledger.records = Object.fromEntries(
        Object.entries(ledger.records)
          .sort((left, right) => right[1].lastSentAt.localeCompare(left[1].lastSentAt))
          .slice(0, MAX_CAPSULES),
      );
      await writeAtomic(path, `${JSON.stringify(ledger, null, 2)}\n`);
      return { lines, full, referenced, sentTokens, avoidedTokens };
    } finally {
      await release();
    }
  }

  private async read(path: string, now: Date): Promise<LedgerFile> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as LedgerFile;
      if (parsed.version !== VERSION || typeof parsed.records !== "object") return empty(now);
      const records = Object.fromEntries(
        Object.entries(parsed.records).filter(([, record]) => {
          const age = now.getTime() - Date.parse(record.lastSentAt);
          return Number.isFinite(age) && age <= MAX_AGE_MS;
        }),
      );
      return { version: VERSION, updatedAt: parsed.updatedAt, records };
    } catch {
      return empty(now);
    }
  }

  private path(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100) || "default";
    return join(this.directory, `${safe}.json`);
  }

  private async acquire(sessionId: string): Promise<() => Promise<void>> {
    const lock = `${this.path(sessionId)}.lock`;
    for (let attempt = 0; ; attempt++) {
      try {
        await mkdir(lock);
        return async () => rm(lock, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 200) throw error;
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    }
  }
}

function empty(now: Date): LedgerFile {
  return { version: VERSION, updatedAt: now.toISOString(), records: {} };
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
