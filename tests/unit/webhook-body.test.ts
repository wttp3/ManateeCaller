import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  decodeWebhookBody,
  MalformedWebhookBodyError,
  PayloadTooLargeError,
  readCappedBody,
} from "../../src/webhook/raw-body.js";

async function* chunks(parts: Buffer[]): AsyncGenerator<Buffer> {
  for (const part of parts) {
    yield part;
  }
}

describe("webhook raw body", () => {
  it("returns the exact bytes under the cap", async () => {
    const body = await readCappedBody(chunks([Buffer.from("abc"), Buffer.from("def")]), 6);
    expect(body.toString("utf8")).toBe("abcdef");
  });

  it("rejects a body past the cap after draining it", async () => {
    await expect(readCappedBody(chunks([Buffer.from("abcdef"), Buffer.from("gh")]), 6)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
  });

  it("inflates a gzip body only when the bytes themselves are gzip", () => {
    const json = Buffer.from('{"entry":[]}');
    const gzipped = gzipSync(json);
    expect(decodeWebhookBody(gzipped, 1024).equals(json)).toBe(true);
    expect(decodeWebhookBody(json, 1024).equals(json)).toBe(true);
    expect(() => decodeWebhookBody(Buffer.from([0x1f, 0x8b, 0x00]), 1024)).toThrow(MalformedWebhookBodyError);
    const bomb = gzipSync(Buffer.alloc(200, 0x61));
    expect(() => decodeWebhookBody(bomb, 50)).toThrow(PayloadTooLargeError);
  });
});