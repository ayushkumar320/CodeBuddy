export type DatabaseClientConfig = {
  postgresUrl: string;
};

export function createDatabaseClient(_config: DatabaseClientConfig): never {
  throw new Error("Database client is implemented in Phase 2.");
}
