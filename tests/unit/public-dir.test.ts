import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMigrationsDir, resolvePublicDir } from "../../src/utils/runtime-paths.js";

const roots: string[] = [];

function makeReleaseTree(): string {
  const root = mkdtempSync(join(tmpdir(), "manateecaller-paths-"));
  roots.push(root);
  mkdirSync(join(root, "public"), { recursive: true });
  mkdirSync(join(root, "src", "db"), { recursive: true });
  mkdirSync(join(root, "dist", "db"), { recursive: true });
  mkdirSync(join(root, "migrations"), { recursive: true });
  writeFileSync(join(root, "public", "index.html"), "<!doctype html>");
  writeFileSync(join(root, "migrations", "001_initial.sql"), "-- fixture");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolvePublicDir", () => {
  it("finds public/ from source and from dist", () => {
    const root = makeReleaseTree();
    expect(resolvePublicDir(join(root, "src"))).toBe(join(root, "public"));
    expect(resolvePublicDir(join(root, "dist"))).toBe(join(root, "public"));
  });

  it("finds public/ from a nested compiled module directory", () => {
    const root = makeReleaseTree();
    expect(resolvePublicDir(join(root, "dist", "db"))).toBe(join(root, "public"));
  });

  it("fails when public/ is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "manateecaller-no-public-"));
    roots.push(root);
    mkdirSync(join(root, "dist"), { recursive: true });
    expect(() => resolvePublicDir(join(root, "dist"))).toThrow(/public directory not found/);
  });
});

describe("resolveMigrationsDir", () => {
  it("finds migrations/ from source and from dist", () => {
    const root = makeReleaseTree();
    expect(resolveMigrationsDir(join(root, "src", "db"))).toBe(join(root, "migrations"));
    expect(resolveMigrationsDir(join(root, "dist", "db"))).toBe(join(root, "migrations"));
  });
});
