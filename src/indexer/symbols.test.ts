import { describe, expect, it } from "vitest";
import { extractSymbolTable, supportsSymbols, symbolSignatures } from "./symbols.js";

describe("supportsSymbols", () => {
  it("accepts TS/JS extensions and rejects others", () => {
    expect(supportsSymbols("src/a.ts")).toBe(true);
    expect(supportsSymbols("src/a.tsx")).toBe(true);
    expect(supportsSymbols("README.md")).toBe(false);
    expect(supportsSymbols("data.json")).toBe(false);
  });
});

describe("extractSymbolTable", () => {
  it("extracts top-level declarations with kind, name, and export flag", () => {
    const source = [
      "export function login(user: string) {", // 1
      "  return user;", // 2
      "}", // 3
      "", // 4
      "class Session {", // 5
      "  id = 1;", // 6
      "}", // 7
      "export const MAX = 10;", // 8
      "export type Token = string;", // 9
      "interface User {", // 10
      "  name: string;", // 11
      "}", // 12
    ].join("\n");

    const table = extractSymbolTable(source);
    const byName = Object.fromEntries(table.map((s) => [s.name, s]));

    expect(byName.login?.kind).toBe("function");
    expect(byName.login?.exported).toBe(true);
    expect(byName.login?.startLine).toBe(1);
    expect(byName.login?.endLine).toBe(3); // brace-matched block

    expect(byName.Session?.kind).toBe("class");
    expect(byName.Session?.exported).toBe(false);
    expect(byName.Session?.endLine).toBe(7);

    expect(byName.MAX?.kind).toBe("const");
    expect(byName.MAX?.startLine).toBe(8);
    expect(byName.MAX?.endLine).toBe(8); // one-liner

    expect(byName.Token?.kind).toBe("type");
    expect(byName.User?.kind).toBe("interface");
  });

  it("ignores nested (indented) declarations", () => {
    const source = ["class Outer {", "  function inner() {}", "}"].join("\n");
    const table = extractSymbolTable(source);
    expect(table.map((s) => s.name)).toEqual(["Outer"]);
  });

  it("builds a clean one-line signature", () => {
    const [symbol] = extractSymbolTable(
      "export async function run(x: number): Promise<void> {\n}\n",
    );
    expect(symbol?.signature).toBe("export async function run(x: number): Promise<void>");
  });
});

describe("symbolSignatures", () => {
  it("renders bounded signature lines with an export prefix", () => {
    const table = extractSymbolTable("export const a = 1;\nconst b = 2;\n");
    const sigs = symbolSignatures(table, 12);
    expect(sigs[0]).toContain("export");
    expect(sigs.some((s) => s.includes("const b"))).toBe(true);
  });
});
