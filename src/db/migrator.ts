import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { DatabaseClient } from "./client.js";

/**
 * Locate the bundled migrations folder. Works whether the package is being
 * run from source (src/db/migrations) or from a published dist install
 * (dist/db/migrations or src/db/migrations alongside dist).
 */
export function resolveMigrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "migrations"),
    resolve(here, "..", "..", "src", "db", "migrations"),
    resolve(here, "..", "..", "..", "src", "db", "migrations"),
    resolve(process.cwd(), "src", "db", "migrations"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not locate migrations folder. Looked in:\n  ${candidates.join("\n  ")}`);
}

export async function runMigrations(client: DatabaseClient): Promise<void> {
  const migrationsFolder = resolveMigrationsFolder();
  await migrate(client.db, { migrationsFolder });
}
