/**
 * "오늘" for the stamp ticket: the calendar day in Asia/Seoul, whatever the server's or the
 * booth's own timezone. Korea has had no daylight saving since 1988, so the day always starts at
 * 00:00 +09:00 (15:00 UTC of the day before).
 */
const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC instant at which the Seoul day holding `at` began, as an ISO string. */
export function seoulDayStart(at: Date | string): string {
  const ms = typeof at === "string" ? Date.parse(at) : at.getTime();
  if (!Number.isFinite(ms)) throw new RangeError("invalid date");
  const local = ms + SEOUL_OFFSET_MS;
  const startLocal = local - (((local % DAY_MS) + DAY_MS) % DAY_MS);
  return new Date(startLocal - SEOUL_OFFSET_MS).toISOString();
}

/** A ticket number the guest may see: a whole number from 1, or null. */
export function cleanOrdinal(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}
