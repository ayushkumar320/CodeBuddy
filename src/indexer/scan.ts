import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { SUPPORTED_EXTENSIONS } from "./summary.js";

/**
 * Enumerate the repo-relative POSIX paths the indexer should consider.
 *
 * `.gitignore` respect is delegated to git itself: `git ls-files` lists tracked
 * plus untracked-but-not-ignored files, which is exactly the set a developer
 * expects to be "in the project". When the directory is not a git repository we
 * fall back to a plain walk with a conservative ignore list so indexing still
 * works on partially configured repos.
 *
 * CodeBuddy's own generated artifacts (`.codebuddy/`, `graphify-out/`) are
 * always excluded — the index does not index itself.
 */

const FALLBACK_IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".codebuddy",
  "graphify-out",
  ".next",
  ".turbo",
  "out",
]);

export async function listIndexableFiles(repositoryRoot: string): Promise<string[]> {
  const tracked = await gitListFiles(repositoryRoot);
  const paths = tracked ?? (await walkFiles(repositoryRoot));
  return paths
    .map(normalize)
    .filter((path) => !path.startsWith(".codebuddy/") && !path.startsWith("graphify-out/"))
    .filter((path) => SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase()))
    .sort();
}

/** Returns null when the directory is not a git repository. */
async function gitListFiles(repositoryRoot: string): Promise<string[] | null> {
  const result = await runGit(repositoryRoot, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (result.code !== 0) return null;
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (FALLBACK_IGNORED_DIRECTORIES.has(entry.name)) continue;
        await walk(absolute);
        continue;
      }
      if (entry.isFile()) files.push(relative(root, absolute));
    }
  };
  await walk(root);
  return files;
}

function runGit(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    // A missing git binary should degrade to the walk fallback, not crash.
    child.on("error", () => resolveResult({ code: -1, stdout: "", stderr: "git unavailable" }));
    child.on("close", (code) => resolveResult({ code: code ?? 0, stdout, stderr }));
  });
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}
