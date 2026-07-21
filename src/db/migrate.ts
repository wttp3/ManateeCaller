import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { loadConfig } from "../config/index.js";
import { getPool, closePool, sql } from "./pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "../../migrations");

async function migrate(): Promise<void> {
  const config = loadConfig();
  const pool = await getPool(config);

  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'schema_migrations')
    BEGIN
      CREATE TABLE schema_migrations (
        version NVARCHAR(64) NOT NULL PRIMARY KEY,
        applied_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
      );
    END;
  `);

  const applied = await pool
    .request()
    .query<{ version: string }>("SELECT version FROM schema_migrations");
  const appliedSet = new Set(applied.recordset.map((r: { version: string }) => r.version));

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) {
      continue;
    }

    const sqlText = readFileSync(join(migrationsDir, file), "utf8");
    const batches = sqlText.split(/\nGO\s*\n/i);

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      for (const batch of batches) {
        const trimmed = batch.trim();
        if (trimmed) {
          await new sql.Request(transaction).query(trimmed);
        }
      }
      await new sql.Request(transaction)
        .input("version", sql.NVarChar(64), file)
        .query("INSERT INTO schema_migrations (version) VALUES (@version)");
      await transaction.commit();
      console.log(`Applied migration: ${file}`);
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }

  await closePool();
  console.log("Migrations complete.");
}

migrate().catch((err) => {
  console.error("Migration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
