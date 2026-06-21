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
    // postgres.js logs NOTICE messages (e.g. "extension already exists,
    // skipping") to stdout by default. Over the MCP stdio transport stdout
    // carries JSON-RPC, so any notice corrupts the stream and the client
    // reports "Unexpected token … is not valid JSON". Route notices to
    // stderr instead, where logs belong.
    onnotice: (notice) => {
      process.stderr.write(`${JSON.stringify(notice)}\n`);
    },
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
