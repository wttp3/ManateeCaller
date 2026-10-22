export function normalizeOptInKeyword(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll("’", "'")
    .replaceAll("‘", "'")
    .replace(/\s+/g, " ");
}

export function isOptInMessage(
  input: { text?: string; buttonReplyId?: string },
  keyword: string,
): boolean {
  const text = normalizeOptInKeyword(input.text ?? "");
  if (text.length > 0 && text === normalizeOptInKeyword(keyword)) {
    return true;
  }
  return input.buttonReplyId === "IM_IN";
}
