const SENSITIVE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /EAA[A-Za-z0-9]+/g,
  /sk_[A-Za-z0-9]+/g,
  /\+[1-9]\d{7,14}/g,
];

export function redactMessage(message: string): string {
  let result = message;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, "[redacted]");
  }
  return result;
}

export function logInfo(message: string, meta?: Record<string, unknown>): void {
  const safeMeta = meta
    ? Object.fromEntries(
        Object.entries(meta).map(([k, v]) => [
          k,
          typeof v === "string" ? redactMessage(v) : v,
        ]),
      )
    : undefined;
  console.log(JSON.stringify({ level: "info", message: redactMessage(message), ...safeMeta }));
}

export function logError(message: string, meta?: Record<string, unknown>): void {
  logInfo(message, { ...meta, level: "error" });
}
