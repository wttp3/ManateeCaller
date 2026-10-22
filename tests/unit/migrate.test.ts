import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pendingMigrationFiles } from "../../src/db/pending-migrations.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("pendingMigrationFiles", () => {
  it("applies sql files once, in order", () => {
    const files = ["002_b.sql", "001_a.sql", "README.md", "notes.txt"];
    const first = pendingMigrationFiles(files, []);
    expect(first).toEqual(["001_a.sql", "002_b.sql"]);
    expect(pendingMigrationFiles(files, first)).toEqual([]);
    expect(pendingMigrationFiles(files, ["001_a.sql"])).toEqual(["002_b.sql"]);
  });

  it("is idempotent for the shipped migrations", () => {
    const files = readdirSync(join(repoRoot, "migrations"));
    const first = pendingMigrationFiles(files, []);
    expect(first).toEqual(["001_initial.sql"]);
    expect(pendingMigrationFiles(files, first)).toEqual([]);
    expect(pendingMigrationFiles(files, new Set(first))).toEqual([]);
  });
});

describe("migrate:prod", () => {
  it("runs the compiled migrator with node", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["migrate:prod"]).toBe("node dist/db/migrate.js");
    expect(pkg.scripts["migrate:prod"]).not.toContain("tsx");
  });
});
