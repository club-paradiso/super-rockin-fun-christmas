import type { EventSettings, WallHours } from "@/lib/storage/types";

/**
 * Media-wall opening hours (docs/ARCHITECTURE.md 1.5 "운영 시간"). Pure: the hub asks it on every
 * feed poll, so a change in /admin reaches the wall within one poll. Staff override first, then
 * the hours; no hours = always open. Times are wall-clock in the event's time zone.
 */
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidHours(h: unknown): h is WallHours {
  const v = h as Partial<WallHours> | null;
  return (
    !!v &&
    typeof v.start === "string" &&
    typeof v.end === "string" &&
    HHMM.test(v.start) &&
    HHMM.test(v.end) &&
    v.start !== v.end
  );
}

/** "HH:MM" of `now` in `timeZone`. */
export function localHHMM(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("hour")}:${get("minute")}`;
}

export type WallOpenReason = "forced-on" | "forced-off" | "always" | "in-hours" | "out-of-hours";

export function wallOpen(
  settings: Pick<EventSettings, "wallHours" | "wallForce">,
  now: Date,
  timeZone: string,
): { open: boolean; reason: WallOpenReason; opensAt: string | null } {
  if (settings.wallForce === "on") return { open: true, reason: "forced-on", opensAt: null };
  if (settings.wallForce === "off") return { open: false, reason: "forced-off", opensAt: null };
  const h = settings.wallHours;
  if (!h) return { open: true, reason: "always", opensAt: null };
  const t = localHHMM(now, timeZone);
  // A window may run past midnight (e.g. 18:00-01:00). String order is time order for HH:MM.
  const inside = h.start < h.end ? t >= h.start && t < h.end : t >= h.start || t < h.end;
  return inside
    ? { open: true, reason: "in-hours", opensAt: null }
    : { open: false, reason: "out-of-hours", opensAt: h.start };
}
