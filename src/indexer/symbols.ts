import { extname } from "node:path";

/**
 * Lightweight symbol extraction (Roadmap N.3). Records the top-level symbols of
 * a TS/JS file — name, kind, line range, and a one-line signature — using regex
 * + brace matching, deliberately *not* a full parser (consistent with the
 * indexer's "no fragile parser platform" stance). This lets context represent a
 * file by its public API (a handful of signatures) instead of its whole body,
 * so an agent can see what a file offers without reading it.
 *
 * It is a heuristic: it targets the common top-level declaration forms and skips
 * anything it can't classify. Deterministic — the same file always yields the
 * same table.
 */

export type SymbolKind = "function" | "class" | "interface" | "type" | "enum" | "const";

export type SymbolSpan = {
  name: string;
  kind: SymbolKind;
  /** 1-based inclusive line range. */
  startLine: number;
  endLine: number;
  /** One-line signature (declaration head), truncated. */
  signature: string;
  exported: boolean;
};

const SYMBOL_CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SIGNATURE_MAX = 120;
const SYMBOL_LIMIT = 100;

/** True when a symbol table can be extracted for this path's language. */
export function supportsSymbols(path: string): boolean {
  return SYMBOL_CODE_EXTENSIONS.has(extname(path).toLowerCase());
}

const DECLARATION =
  /^(?<export>export\s+)?(?<default>default\s+)?(?<mods>(?:declare\s+|abstract\s+|async\s+)*)(?<kind>function\*?|class|interface|type|enum|const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)/;

export function extractSymbolTable(content: string): SymbolSpan[] {
  const lines = content.split(/\r?\n/);
  const symbols: SymbolSpan[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    // Top-level only: a declaration that starts at column 0 (optionally exported).
    if (/^\s/.test(line)) continue;
    const match = DECLARATION.exec(line);
    if (!match?.groups) continue;

    const rawKind = match.groups.kind ?? "";
    const kind = normalizeKind(rawKind);
    const name = match.groups.name ?? "";
    if (!name) continue;

    const startLine = index + 1;
    const endLine = findEndLine(lines, index) + 1;
    symbols.push({
      name,
      kind,
      startLine,
      endLine,
      signature: buildSignature(line),
      exported: Boolean(match.groups.export),
    });
    if (symbols.length >= SYMBOL_LIMIT) break;
  }

  return symbols;
}

/**
 * Render a file's symbols as compact signature lines (the "symbol capsule").
 * The signature already preserves a leading `export`, so it is used verbatim.
 */
export function symbolSignatures(symbols: SymbolSpan[], limit = 12): string[] {
  return symbols.slice(0, limit).map((symbol) => symbol.signature);
}

function normalizeKind(raw: string): SymbolKind {
  if (raw.startsWith("function")) return "function";
  if (raw === "let" || raw === "var" || raw === "const") return "const";
  return raw as SymbolKind;
}

function buildSignature(line: string): string {
  const head = line.split("{")[0]?.split("=>")[0]?.trimEnd() ?? line.trim();
  const cleaned = head.replace(/[=;{]\s*$/, "").trim();
  return cleaned.length <= SIGNATURE_MAX ? cleaned : `${cleaned.slice(0, SIGNATURE_MAX - 1)}…`;
}

/**
 * Find the last line of a declaration by brace balancing. If the declaration has
 * no block on its start line (a one-line const/type), the range is a single
 * line. Naive about braces in strings/comments — acceptable for a heuristic.
 */
function findEndLine(lines: string[], startIndex: number): number {
  const first = lines[startIndex] ?? "";
  if (!first.includes("{")) return startIndex;

  let depth = 0;
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index] ?? "";
    for (const char of line) {
      if (char === "{") depth++;
      else if (char === "}") depth--;
    }
    if (depth <= 0) return index;
  }
  return lines.length - 1;
}
