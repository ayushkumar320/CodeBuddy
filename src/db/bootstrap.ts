import type { Sql } from "postgres";
import { VECTOR_DIMENSIONS } from "./schema.js";

export type PgvectorHealth = {
  available: boolean;
  installedVersion: string | null;
};

export type EmbeddingDimensionCheck = {
  ok: boolean;
  expectedDimensions: number;
  configuredModels: string[];
  existingModels: string[];
  reason?: string;
};

export async function enablePgvector(sql: Sql): Promise<void> {
  await sql`create extension if not exists vector`;
}

export async function checkPgvector(sql: Sql): Promise<PgvectorHealth> {
  const result = await sql<{ extversion: string }[]>`
    select extversion from pg_extension where extname = 'vector'
  `;

  return {
    available: result.length > 0,
    installedVersion: result[0]?.extversion ?? null,
  };
}

export async function getExistingEmbeddingModels(sql: Sql): Promise<string[]> {
  const rows = await sql<{ embedding_model: string }[]>`
    select distinct embedding_model
    from embeddings
    where embedding_model is not null
    order by embedding_model
  `;

  return rows.map((row) => row.embedding_model);
}

export async function checkEmbeddingDimensionCompatibility(
  sql: Sql,
  configuredModels: Array<{ id: string; dimensions?: number }>,
  expectedDimensions = VECTOR_DIMENSIONS,
): Promise<EmbeddingDimensionCheck> {
  const mismatchedConfiguredModel = configuredModels.find(
    (model) => model.dimensions !== expectedDimensions,
  );

  if (mismatchedConfiguredModel) {
    return {
      ok: false,
      expectedDimensions,
      configuredModels: configuredModels.map((model) => model.id),
      existingModels: [],
      reason: `Configured embedding model ${mismatchedConfiguredModel.id} does not match ${expectedDimensions} dimensions.`,
    };
  }

  const existingModels = await getExistingEmbeddingModels(sql);
  const configuredModelIds = new Set(configuredModels.map((model) => model.id));
  const unknownExistingModels = existingModels.filter((model) => !configuredModelIds.has(model));

  if (unknownExistingModels.length > 0) {
    return {
      ok: false,
      expectedDimensions,
      configuredModels: configuredModels.map((model) => model.id),
      existingModels,
      reason: `Existing embeddings use unconfigured models: ${unknownExistingModels.join(", ")}.`,
    };
  }

  return {
    ok: true,
    expectedDimensions,
    configuredModels: configuredModels.map((model) => model.id),
    existingModels,
  };
}

export async function bootstrapDatabase(sql: Sql): Promise<PgvectorHealth> {
  await enablePgvector(sql);
  return checkPgvector(sql);
}
