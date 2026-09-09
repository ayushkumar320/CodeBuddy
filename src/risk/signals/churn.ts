import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Signal, SignalContribution } from "../types.js";

export type ChurnSignalOptions = {
  repositoryRoot: string;
  enabled?: boolean;
  coefficient?: number;
  since?: string;
};

type CommitRecord = {
  sha: string;
  author: string;
  ts: string;
  message: string;
};

export function createChurnSignal(options: ChurnSignalOptions): Signal {
  return {
    id: "git-churn",
    category: "churn",
    enabled: options.enabled ?? true,
    coefficient: options.coefficient ?? 0.7,
    async assess(input) {
      const contributions: SignalContribution[] = [];
      for (const path of input.paths) {
        const commits = await gitLogForPath(
          options.repositoryRoot,
          path,
          options.since ?? "30 days ago",
        );
        if (commits.length === 0) continue;
        const authors = new Set(commits.map((commit) => commit.author));
        const reverts = commits.filter((commit) => /revert|rollback|backout/i.test(commit.message));
        const weight = Math.min(100, commits.length * 8 + authors.size * 12 + reverts.length * 20);
        contributions.push({
          path,
          weight,
          reason: `${path} changed ${commits.length} time${commits.length === 1 ? "" : "s"} in the recent git history by ${authors.size} author${authors.size === 1 ? "" : "s"}.`,
          evidence: commits.slice(0, 5).map((commit) => ({
            kind: "git_commit" as const,
            sha: commit.sha,
            message: commit.message,
            ts: commit.ts,
          })),
        });
      }
      return contributions;
    },
  };
}

async function gitLogForPath(
  repositoryRoot: string,
  path: string,
  since: string,
): Promise<CommitRecord[]> {
  const root = await runGit(repositoryRoot, ["rev-parse", "--show-toplevel"]);
  if (root.code !== 0 || resolve(root.stdout.trim()) !== resolve(repositoryRoot)) return [];
  const result = await runGit(repositoryRoot, [
    "log",
    "--follow",
    `--since=${since}`,
    "--format=%H%x1f%an%x1f%cI%x1f%s%x1e",
    "--",
    path,
  ]);
  if (result.code !== 0 || result.stdout.trim().length === 0) return [];
  return result.stdout
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = "", author = "", ts = "", message = ""] = record.split("\x1f");
      return { sha, author, ts, message };
    })
    .filter((record) => record.sha.length > 0);
}

function runGit(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}
