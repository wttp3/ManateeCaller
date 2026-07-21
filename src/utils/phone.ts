export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) {
    return digits;
  }
  if (digits.startsWith("00")) {
    return `+${digits.slice(2)}`;
  }
  if (digits.startsWith("0")) {
    return `+44${digits.slice(1)}`;
  }
  return `+${digits}`;
}

export function isValidE164(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}
