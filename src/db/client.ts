import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type DatabaseClientConfig = {
  postgresUrl: string;
  maxConnections?: number;
};

export type DatabaseClient = ReturnType<typeof createDatabaseClient>;

export function createDatabaseClient(config: DatabaseClientConfig) {
  const sql = postgres(config.postgresUrl, {
    max: config.maxConnections ?? 10,
  });

  return {
    sql,
    db: drizzle(sql, { schema }),
    async close(): Promise<void> {
      await sql.end();
    },
  };
}

export async function pingDatabase(client: Pick<ReturnType<typeof createDatabaseClient>, "sql">) {
  const result = await client.sql`select 1 as ok`;
  return result[0]?.ok === 1;
}
