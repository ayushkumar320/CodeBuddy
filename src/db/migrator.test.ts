import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveMigrationsFolder } from "./migrator.js";

describe("resolveMigrationsFolder", () => {
  it("finds the migrations folder when running from source", () => {
    const folder = resolveMigrationsFolder();
    expect(folder).toMatch(/migrations$/);
    expect(existsSync(folder)).toBe(true);
  });

  it("the resolved folder contains the journal and at least one SQL file", () => {
    const folder = resolveMigrationsFolder();
    expect(existsSync(`${folder}/meta/_journal.json`)).toBe(true);
  });
});
