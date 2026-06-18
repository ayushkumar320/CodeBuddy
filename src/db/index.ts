export {
  bootstrapDatabase,
  checkEmbeddingDimensionCompatibility,
  checkPgvector,
  enablePgvector,
  getExistingEmbeddingModels,
} from "./bootstrap.js";
export { createDatabaseClient, pingDatabase } from "./client.js";
export * from "./schema.js";
