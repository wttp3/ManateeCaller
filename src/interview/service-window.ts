import { PROMPTS } from "./constants.js";

export function isServiceWindowOpen(
  expiresAt: Date | string | null | undefined,
  now = Date.now(),
): boolean {
  if (expiresAt == null) {
    return false;
  }
  const time = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  return Number.isFinite(time) && time > now;
}

/**
 * Free-form copy, including the expired notice, is legal only while the
 * customer-service window is open. Otherwise the body is dropped.
 */
export function freeFormBodyWithinWindow(
  body: string,
  expiresAt: Date | string | null | undefined,
  now = Date.now(),
): string | null {
  return isServiceWindowOpen(expiresAt, now) ? body : null;
}

export function expiredNoticeBody(
  expiresAt: Date | string | null | undefined,
  now = Date.now(),
): string | null {
  return freeFormBodyWithinWindow(PROMPTS.expired, expiresAt, now);
}
