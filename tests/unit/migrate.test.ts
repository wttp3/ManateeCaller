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
    expect(first).toEqual([
      "001_initial.sql",
      "002_privacy_controls.sql",
      "003_legacy_privacy_backfill.sql",
      "004_strip_job_message_id.sql",
    ]);
    expect(pendingMigrationFiles(files, first)).toEqual([]);
    expect(pendingMigrationFiles(files, new Set(first))).toEqual([]);
  });
});

describe("legacy privacy backfill", () => {
  it("links jobs by session id, scrubs phones, and expires unlinkable webhook rows", () => {
    const sql = readFileSync(join(repoRoot, "migrations/003_legacy_privacy_backfill.sql"), "utf8");
    expect(sql).toContain("JSON_VALUE(j.payload_json, '$.sessionId')");
    expect(sql).toContain("'$.phone'");
    expect(sql).toContain("last_error = NULL");
    expect(sql).toContain("phone_lookup_hash IS NULL");
    expect(sql).toContain("DATEADD(day, -7, SYSUTCDATETIME())");
    expect(sql.toLowerCase()).toContain("cannot be derived");
  });

  it("strips leftover message ids from job payloads", () => {
    const sql = readFileSync(join(repoRoot, "migrations/004_strip_job_message_id.sql"), "utf8");
    expect(sql).toContain("'$.messageId'");
    expect(sql).toContain("'$.message_id'");
  });

  it("matches legacy jobs by session id in stop and erasure", () => {
    const source = readFileSync(join(repoRoot, "src/services/participant.service.ts"), "utf8");
    const matches = source.match(/JSON_VALUE\(payload_json, '\$\.sessionId'\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
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
