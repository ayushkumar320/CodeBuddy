export {
  bootstrapDatabase,
  checkEmbeddingDimensionCompatibility,
  checkPgvector,
  enablePgvector,
  getExistingEmbeddingModels,
} from "./bootstrap.js";
export type { DatabaseClient } from "./client.js";
export { createDatabaseClient, pingDatabase } from "./client.js";
export { createPostgresRepository, PostgresMemoryRepository } from "./repository.js";
export * from "./schema.js";
