import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function keyFromHex(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

export function encryptString(plaintext: string, keyHex: string): string {
  const key = keyFromHex(keyHex);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptString(ciphertext: string, keyHex: string): string {
  const key = keyFromHex(keyHex);
  const data = Buffer.from(ciphertext, "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function hmacHex(input: string, keyHex: string): string {
  return createHmac("sha256", keyFromHex(keyHex)).update(input).digest("hex");
}

export function randomSlug(length = 12): string {
  return randomBytes(length).toString("hex").slice(0, length);
}
