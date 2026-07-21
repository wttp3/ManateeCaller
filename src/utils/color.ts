import { hmacHex } from "./crypto.js";

export function normalizeTranscript(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function combineTranscripts(parts: string[]): string {
  return parts.map(normalizeTranscript).filter(Boolean).join("|");
}

export function transcriptToColor(combined: string, tileHmacKey: string): string {
  const digest = hmacHex(combined, tileHmacKey);
  return `#${digest.slice(0, 6)}`;
}
