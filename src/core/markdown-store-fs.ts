import { lstat, open, rename } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

/**
 * Filesystem helpers shared by the Markdown-backed stores
 * (`MemoryFileStore`, `PlanFileStore`). These enforce the security
 * invariants that keep `.codebuddy/` writes inside the repository root:
 * no path traversal, no symlinked path components, and crash-safe atomic
 * writes. Keep this module small and audited; both stores depend on it.
 */

/**
 * Resolve `path` and assert it stays inside `root`. Returns the absolute
 * path. Throws if the resolved path escapes the root.
 */
export function resolveWithinRoot(root: string, path: string): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(path);
  const relativePath = relative(absoluteRoot, absolute);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativePath === "") {
    throw new Error(`Path escapes repository root: ${path}`);
  }
  return absolute;
}

/**
 * Walk each path component between `root` and `target` and refuse if any
 * component is a symbolic link. Prevents a planted symlink from
 * redirecting a write outside the repository. Missing components are
 * fine — the caller creates them.
 */
export async function assertNoSymlinkBetween(root: string, target: string): Promise<void> {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  const relativeTarget = relative(absoluteRoot, absoluteTarget);
  if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
    throw new Error(`Path escapes repository root: ${target}`);
  }

  let current = absoluteRoot;
  const parts = relativeTarget.split(sep).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error(`Refusing to use symlinked path: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

/**
 * Write `document` to `path` atomically: write to a unique temp file with
 * an exclusive (`wx`) create, fsync, then rename into place. A crash mid-
 * write leaves either the old file or nothing — never a partial file.
 */
export async function writeAtomic(path: string, document: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(document, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
}

/**
 * Split a Markdown document with leading YAML front matter into its
 * front-matter text and body. Throws on malformed or unterminated
 * front matter so hand-edited files fail loudly rather than silently
 * losing fields.
 */
export function parseFrontMatter(document: string): { frontMatter: string; content: string } {
  if (!document.startsWith("---\n")) {
    throw new Error("Markdown file must start with YAML front matter.");
  }
  const closingIndex = document.indexOf("\n---\n", 4);
  if (closingIndex === -1) {
    throw new Error("Markdown file has unterminated YAML front matter.");
  }
  return {
    frontMatter: document.slice(4, closingIndex),
    content: document.slice(closingIndex + 5),
  };
}

/**
 * Compose a Markdown document from serialized front-matter YAML and a
 * body. Ensures exactly one trailing newline on the body so files are
 * stable across rewrites (minimal git diffs).
 */
export function composeMarkdown(frontMatterYaml: string, body: string): string {
  const trimmedFrontMatter = frontMatterYaml.trimEnd();
  const content = body.endsWith("\n") ? body : `${body}\n`;
  return `---\n${trimmedFrontMatter}\n---\n${content}`;
}
