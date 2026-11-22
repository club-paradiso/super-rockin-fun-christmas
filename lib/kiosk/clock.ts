/**
 * The booth's idea of "now", taken from the server (the hub), never from the tablet's own clock:
 * a tablet left on the wrong date would stamp the wrong day on every photo (the polaroid date
 * stamp, D-v2). The server's time arrives with the page and with every heartbeat; the booth keeps
 * the difference to its own clock and applies it. Kept in localStorage so a reload while the hub
 * is unreachable still knows the offset.
 */

export const CLOCK_KEY = "ftl.serverClockOffsetMs";

export interface ServerClock {
  /** Server time now (tablet time plus the last known offset). */
  now(): Date;
  /** A reading from the server: `serverIso` as received between `sentAt` and `receivedAt`. */
  update(serverIso: string, sentAt: number, receivedAt: number): void;
  /** Milliseconds to add to the tablet clock; null before any reading. */
  offsetMs(): number | null;
}

/** offset = server time − the middle of the request's round trip on the tablet clock. */
export function clockOffset(serverIso: string, sentAt: number, receivedAt: number): number | null {
  const server = Date.parse(serverIso);
  if (!Number.isFinite(server) || !(receivedAt >= sentAt)) return null;
  return Math.round(server - (sentAt + receivedAt) / 2);
}

export function createServerClock(
  initial: { serverIso?: string; at?: number } = {},
  storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage(),
  tabletNow: () => number = Date.now,
): ServerClock {
  let offset: number | null = null;
  const stored = Number(storage?.getItem(CLOCK_KEY) ?? NaN);
  if (Number.isFinite(stored)) offset = stored;
  const save = () => {
    try {
      if (offset !== null) storage?.setItem(CLOCK_KEY, String(offset));
    } catch {}
  };
  if (initial.serverIso) {
    const at = initial.at ?? tabletNow();
    const fresh = clockOffset(initial.serverIso, at, at);
    if (fresh !== null) {
      offset = fresh;
      save();
    }
  }
  return {
    now: () => new Date(tabletNow() + (offset ?? 0)),
    offsetMs: () => offset,
    update(serverIso, sentAt, receivedAt) {
      const fresh = clockOffset(serverIso, sentAt, receivedAt);
      if (fresh === null) return;
      offset = fresh;
      save();
    },
  };
}

function safeStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
