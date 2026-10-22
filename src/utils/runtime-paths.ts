import { existsSync } from "node:fs";
import { join } from "node:path";

function resolveFirstExisting(moduleDir: string, label: string, relatives: string[][]): string {
  for (const segments of relatives) {
    const candidate = join(moduleDir, ...segments);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`${label} directory not found from ${moduleDir}`);
}

/**
 * Static files live at the release root `public/`.
 * Source runs from `src/` (`../public`). Compiled output runs from `dist/`
 * (`../public`). A nested module directory falls back one level further.
 */
export function resolvePublicDir(moduleDir: string): string {
  return resolveFirstExisting(moduleDir, "public", [
    ["..", "public"],
    ["..", "..", "public"],
  ]);
}

/**
 * SQL migrations live at the release root `migrations/`.
 * `src/db` and `dist/db` are both two levels down.
 */
export function resolveMigrationsDir(moduleDir: string): string {
  return resolveFirstExisting(moduleDir, "migrations", [
    ["..", "..", "migrations"],
    ["..", "migrations"],
  ]);
}
