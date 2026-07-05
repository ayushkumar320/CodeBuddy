import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "./version.js";

describe("VERSION", () => {
  it("matches the version declared in package.json (single source of truth)", async () => {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("is a valid semver string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});
