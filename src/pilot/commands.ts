function normalizeCommandText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll("’", "'")
    .replaceAll("‘", "'")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Case, hyphens, and whitespace are ignored so "opt out" and "OPT-OUT" match. */
export function compactCommand(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  return normalizeCommandText(value).replace(/ /g, "");
}

const STOP_COMMANDS = new Set(["stop", "unsubscribe", "cancel", "optout"]);

export function isStopCommand(input: { text?: string | null; buttonReplyId?: string | null }): boolean {
  return STOP_COMMANDS.has(compactCommand(input.text)) || STOP_COMMANDS.has(compactCommand(input.buttonReplyId));
}

export function isErasureCommand(
  input: { text?: string | null; buttonReplyId?: string | null },
  keyword: string,
): boolean {
  const expected = compactCommand(keyword);
  if (!expected) {
    return false;
  }
  return compactCommand(input.text) === expected || compactCommand(input.buttonReplyId) === expected;
}
