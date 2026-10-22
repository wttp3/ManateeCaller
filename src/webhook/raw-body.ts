import { gunzipSync } from "node:zlib";

export class PayloadTooLargeError extends Error {
  readonly status = 413;

  constructor() {
    super("Webhook body too large");
    this.name = "PayloadTooLargeError";
  }
}

export class MalformedWebhookBodyError extends Error {
  readonly status = 400;

  constructor() {
    super("Malformed webhook body");
    this.name = "MalformedWebhookBodyError";
  }
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (typeof chunk === "string") {
    return Buffer.from(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  throw new MalformedWebhookBodyError();
}

/**
 * Read the request entity exactly as forwarded.
 * Bytes past the cap are discarded, not stored, and the stream is still drained.
 */
export async function readCappedBody(stream: AsyncIterable<unknown>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of stream) {
    const buf = toBuffer(chunk);
    received += buf.length;
    if (received > maxBytes) {
      continue;
    }
    chunks.push(buf);
  }
  if (received > maxBytes) {
    throw new PayloadTooLargeError();
  }
  return Buffer.concat(chunks);
}

function isGzip(raw: Buffer): boolean {
  return raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;
}

/**
 * JSON bytes for parsing, after the signature has been checked on `raw`.
 * A gzip magic header is inflated here. A body a proxy already decoded
 * (no magic bytes) is returned unchanged, even if Content-Encoding says gzip.
 */
export function decodeWebhookBody(raw: Buffer, maxBytes: number): Buffer {
  if (!isGzip(raw)) {
    return raw;
  }
  try {
    return gunzipSync(raw, { maxOutputLength: maxBytes });
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
    if (code === "ERR_BUFFER_TOO_LARGE") {
      throw new PayloadTooLargeError();
    }
    throw new MalformedWebhookBodyError();
  }
}
