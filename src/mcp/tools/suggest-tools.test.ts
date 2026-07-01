import { describe, expect, it } from "vitest";
import { mcpToolInputSchemas } from "./index.js";

describe("code_suggestions MCP tool schema", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(mcpToolInputSchemas.code_suggestions.parse({})).toEqual({});
  });

  it("accepts paths, planId, useGit, and limit", () => {
    const parsed = mcpToolInputSchemas.code_suggestions.parse({
      paths: ["src/a.ts"],
      planId: "pln_01abc",
      useGit: true,
      limit: 10,
    });
    expect(parsed.paths).toEqual(["src/a.ts"]);
    expect(parsed.limit).toBe(10);
  });

  it("rejects a non-positive limit and an empty path", () => {
    expect(() => mcpToolInputSchemas.code_suggestions.parse({ limit: 0 })).toThrow();
    expect(() => mcpToolInputSchemas.code_suggestions.parse({ paths: [""] })).toThrow();
  });
});
