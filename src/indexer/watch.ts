import { watch as fsWatch } from "node:fs";
import { resolve } from "node:path";
import { type IndexOptions, indexRepository } from "./engine.js";
import type { IndexResult } from "./types.js";

/**
 * `codebuddy watch` is an explicit, foreground incremental indexer — not a
 * hidden daemon (Proposal 04.3 non-goal). It coalesces bursts of file-save
 * events into a single index pass so a formatter rewriting fifty files triggers
 * one refresh, not fifty.
 */

const DEFAULT_DEBOUNCE_MS = 300;

/**
 * A trailing debouncer: `trigger()` schedules `fn` to run after `delayMs` of
 * quiet, collapsing any calls made in that window into one. Runs are
 * serialized — if the work is still running when the timer fires, the next run
 * is deferred until it settles. Exposed on its own so the coalescing logic is
 * testable without touching the filesystem.
 */
export function createCoalescer(
  fn: () => Promise<void>,
  delayMs: number,
): { trigger: () => void; stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let pending = false;
  // Trailing debounce alone starves under sustained event streams (every new
  // event resets the window). maxWait forces a run this long after the FIRST
  // deferred trigger, so continuous activity still indexes eventually.
  let firstTriggerAt: number | null = null;
  let maxWaitTimer: NodeJS.Timeout | null = null;

  const clearTimers = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
    firstTriggerAt = null;
  };

  const run = async () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      await fn();
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      } else {
        clearTimers();
      }
    }
  };

  const schedule = () => {
    const now = Date.now();
    if (firstTriggerAt === null) {
      firstTriggerAt = now;
      maxWaitTimer = setTimeout(() => {
        timer !== null && clearTimeout(timer);
        timer = null;
        void run();
      }, MAX_WAIT_MS);
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delayMs);
  };

  return {
    trigger: schedule,
    stop: () => {
      clearTimers();
    },
  };
}

/** Hard ceiling on how long a burst of events can defer a run. */
const MAX_WAIT_MS = 5_000;

export type WatchOptions = IndexOptions & {
  debounceMs?: number;
  onIndex?: (result: IndexResult) => void;
  onError?: (error: Error) => void;
  /** Abort to stop the watcher (e.g. wired to SIGINT). */
  signal?: AbortSignal;
};

/** Ignore churn we cause ourselves or that git would ignore. */
function isIgnoredEvent(filename: string | null): boolean {
  if (!filename) return false;
  const normalized = filename.replace(/\\/g, "/");
  return (
    normalized.startsWith(".codebuddy/") ||
    normalized.includes("/.git/") ||
    normalized.startsWith(".git/") ||
    normalized.includes("/node_modules/") ||
    normalized.startsWith("node_modules/") ||
    normalized.endsWith(".tmp")
  );
}

/**
 * Watch `repositoryRoot` recursively and run an incremental index on change.
 * Resolves when the signal aborts. Does an initial index pass on start so the
 * manifest is fresh before the first edit.
 */
export async function watchRepository(options: WatchOptions = {}): Promise<void> {
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const runIndex = async () => {
    try {
      const result = await indexRepository({
        repositoryRoot,
        ...(options.now ? { now: options.now } : {}),
      });
      options.onIndex?.(result);
    } catch (error) {
      options.onError?.(error as Error);
    }
  };

  await runIndex();

  const coalescer = createCoalescer(runIndex, debounceMs);
  const watcher = fsWatch(repositoryRoot, { recursive: true }, (_event, filename) => {
    if (isIgnoredEvent(filename)) return;
    coalescer.trigger();
  });

  return new Promise<void>((resolvePromise) => {
    const stop = () => {
      coalescer.stop();
      watcher.close();
      resolvePromise();
    };
    if (options.signal) {
      if (options.signal.aborted) return stop();
      options.signal.addEventListener("abort", stop, { once: true });
    }
    watcher.on("error", () => stop());
  });
}
