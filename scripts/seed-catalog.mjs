import { seedCanonicalCatalog } from "./lib/catalog-seed.mjs";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const summary = await seedCanonicalCatalog(databaseUrl);
console.log(
  `Canonical catalog persisted: ${summary.products} products, ${summary.brands} brands, ${summary.categories} categories, ${summary.stockOpenings} new stock openings.`,
);
