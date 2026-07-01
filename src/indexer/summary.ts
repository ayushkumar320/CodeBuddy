import { extname } from "node:path";

/**
 * Deterministic file summarization. No LLM, no network — the same file always
 * produces the same summary, which keeps the index stable across runs and easy
 * to diff. Symbol extraction is intentionally best-effort regex over source
 * text: good enough to orient an agent, cheap enough to run on every save.
 */

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".cjs": "js",
  ".json": "json",
  ".md": "md",
  ".mdx": "md",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".py": "py",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".sh": "shell",
  ".sql": "sql",
  ".txt": "text",
};

/** Extensions the indexer will read and summarize. */
export const SUPPORTED_EXTENSIONS = new Set(Object.keys(LANGUAGE_BY_EXTENSION));

const CODE_LANGUAGES = new Set(["ts", "tsx", "js", "jsx"]);
const SYMBOL_LIMIT = 8;
const SUMMARY_COMMENT_MAX = 80;

export function languageFor(path: string): string {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()] ?? "text";
}

export type FileSummary = {
  language: string;
  lines: number;
  symbols: string[];
  summary: string;
};

export function summarizeSource(path: string, content: string): FileSummary {
  const language = languageFor(path);
  const lines = countLines(content);
  const symbols = CODE_LANGUAGES.has(language) ? extractSymbols(content) : [];
  const summary = composeSummary(language, lines, symbols, content);
  return { language, lines, symbols, summary };
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.replace(/\r/g, "").replace(/\n$/, "").split("\n").length;
}

/**
 * Pull exported/top-level symbol names from JS/TS source. Covers the common
 * `export <kind> Name` forms, `export default function Name`, and named
 * re-export braces. Order-preserving and de-duplicated.
 */
export function extractSymbols(content: string): string[] {
  const names: string[] = [];
  const push = (name: string | undefined) => {
    const trimmed = name?.trim();
    if (trimmed && /^[A-Za-z_$][\w$]*$/.test(trimmed) && !names.includes(trimmed)) {
      names.push(trimmed);
    }
  };

  const declaration =
    /^export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of content.matchAll(declaration)) push(match[1]);

  const namedExports = /^export\s*\{([^}]*)\}/gm;
  for (const match of content.matchAll(namedExports)) {
    for (const part of (match[1] ?? "").split(",")) {
      // Handle `foo as bar` — record the exported name (`bar`).
      const alias = part.includes(" as ") ? part.split(" as ").pop() : part;
      push(alias);
    }
  }

  return names.slice(0, SYMBOL_LIMIT);
}

function composeSummary(
  language: string,
  lines: number,
  symbols: string[],
  content: string,
): string {
  const head = `${language} • ${lines} line${lines === 1 ? "" : "s"}`;
  if (symbols.length > 0) return `${head} • exports ${symbols.join(", ")}`;
  const comment = leadingComment(content);
  if (comment) return `${head} • ${comment}`;
  return head;
}

/** First meaningful line of a leading comment block, if any. */
function leadingComment(content: string): string | null {
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const stripped = line
      .replace(/^\/\/+/, "")
      .replace(/^\/\*+/, "")
      .replace(/\*+\/$/, "")
      .replace(/^[#*]+/, "")
      .trim();
    if (
      line.startsWith("//") ||
      line.startsWith("/*") ||
      line.startsWith("#") ||
      line.startsWith("*")
    ) {
      if (stripped) return truncate(stripped, SUMMARY_COMMENT_MAX);
      continue;
    }
    // First non-blank line is not a comment: nothing to summarize.
    return null;
  }
  return null;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
