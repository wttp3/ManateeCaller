import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("package engines", () => {
  it("requires Node 22 and excludes Node 23", () => {
    const packageJson = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8"),
    ) as { engines: { node: string } };
    expect(packageJson.engines.node).toBe(">=22 <23");
  });
});
