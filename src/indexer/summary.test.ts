import { describe, expect, it } from "vitest";
import { extractSymbols, languageFor, summarizeSource } from "./summary.js";

describe("languageFor", () => {
  it("maps extensions to coarse language tags", () => {
    expect(languageFor("src/a.ts")).toBe("ts");
    expect(languageFor("src/a.tsx")).toBe("tsx");
    expect(languageFor("scripts/run.mjs")).toBe("js");
    expect(languageFor("README.md")).toBe("md");
    expect(languageFor("data.unknown")).toBe("text");
  });
});

describe("extractSymbols", () => {
  it("collects exported declaration names", () => {
    const source = [
      "export const login = () => {};",
      "export function verify() {}",
      "export class Session {}",
      "export type Token = string;",
      "export interface User {}",
      "export enum Role { Admin }",
      "export default function makeApp() {}",
    ].join("\n");
    expect(extractSymbols(source)).toEqual([
      "login",
      "verify",
      "Session",
      "Token",
      "User",
      "Role",
      "makeApp",
    ]);
  });

  it("collects named re-exports and resolves aliases", () => {
    expect(extractSymbols('export { foo, bar as baz } from "./x";')).toEqual(["foo", "baz"]);
  });

  it("de-duplicates and caps the symbol list", () => {
    const many = Array.from({ length: 20 }, (_, i) => `export const s${i} = ${i};`).join("\n");
    const symbols = extractSymbols(`${many}\nexport const s0 = 0;`);
    expect(symbols.length).toBe(8);
    expect(new Set(symbols).size).toBe(symbols.length);
  });
});

describe("summarizeSource", () => {
  it("summarizes code with its exported symbols", () => {
    const result = summarizeSource("src/auth.ts", "export const login = () => {};\n");
    expect(result.language).toBe("ts");
    expect(result.lines).toBe(1);
    expect(result.symbols).toEqual(["login"]);
    expect(result.summary).toBe("ts • 1 line • exports login");
  });

  it("falls back to a leading comment for non-code or symbol-less files", () => {
    const result = summarizeSource("notes.md", "# Project notes\n\nsome text\n");
    expect(result.language).toBe("md");
    expect(result.summary).toBe("md • 3 lines • Project notes");
  });

  it("counts zero lines for an empty file", () => {
    expect(summarizeSource("empty.ts", "").lines).toBe(0);
  });
});
