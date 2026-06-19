import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { DatabaseClient } from "./client.js";

/**
 * Locate the bundled migrations folder. We may be running from any of:
 *   - source via tsx     ->  src/db/migrator.ts
 *   - built dist         ->  dist/db.../<chunk>.js  (tsup chunked layout)
 *   - flat dist          ->  dist/index.js (single bundle)
 *   - installed npm pkg  ->  node_modules/<pkg>/dist/... or src/db/migrations
 *
 * package.json `files` ships `src/db/migrations`, so even after publish the
 * SQL + meta files live at <pkg root>/src/db/migrations. We walk a few levels
 * up from import.meta.url looking for either `<here>/migrations` or
 * `<pkg root>/src/db/migrations`.
 */
export function resolveMigrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Co-located (src/db/ -> src/db/migrations)
    resolve(here, "migrations"),
    // Built dist (dist/<chunk>.js -> ../src/db/migrations relative paths)
    resolve(here, "..", "src", "db", "migrations"),
    resolve(here, "..", "..", "src", "db", "migrations"),
    resolve(here, "..", "..", "..", "src", "db", "migrations"),
    resolve(here, "..", "..", "..", "..", "src", "db", "migrations"),
    // CWD fallback (developer running from repo root)
    resolve(process.cwd(), "src", "db", "migrations"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Could not locate migrations folder. Tried:\n  ${candidates.join("\n  ")}\n` +
      `If this is an npm-installed package, make sure src/db/migrations was included in the tarball.`,
  );
}

export async function runMigrations(client: DatabaseClient): Promise<void> {
  const migrationsFolder = resolveMigrationsFolder();
  await migrate(client.db, { migrationsFolder });
}
