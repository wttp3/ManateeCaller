import sql from "mssql";
import type { AppConfig } from "../config/index.js";

let pool: sql.ConnectionPool | null = null;

export async function getPool(config: AppConfig): Promise<sql.ConnectionPool> {
  if (pool?.connected) {
    return pool;
  }

  pool = await new sql.ConnectionPool(config.databaseUrl).connect();
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}

export { sql };
