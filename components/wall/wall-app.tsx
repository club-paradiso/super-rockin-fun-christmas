"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { WALL_CONFIG } from "@/config/wall";
import { emptySchedule, stepSchedule, type WallSchedule } from "@/lib/wall/scheduler";
import { wallScreenState, type WallFeed } from "@/lib/wall/states";

/** Where each lit window sits above the village (percent of the screen). */
const SLOT_POSITIONS = [
  { left: 8, top: 14, tilt: -3 },
  { left: 27, top: 6, tilt: 2 },
  { left: 46, top: 16, tilt: -1 },
  { left: 65, top: 7, tilt: 3 },
  { left: 83, top: 15, tilt: -2 },
] as const;

const HOUSES = 7;

/**
 * The media wall. Polls /api/wall/feed, keeps eligible images in memory (object URLs) and lets
 * the pure scheduler decide what enters and leaves. Anything the server stops listing disappears
 * on the same render; after WALL_CONFIG.offlineGraceMs without a successful poll every cached
 * photo is dropped, because the wall can no longer learn about hides or deletions.
 */
export function WallApp() {
  const [feed, setFeed] = useState<WallFeed | null>(null);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [online, setOnline] = useState(true);
  const [revoked, setRevoked] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [images, setImages] = useState<ReadonlyMap<string, string>>(new Map());
  const [schedule, setSchedule] = useState<WallSchedule>(() =>
    emptySchedule(Math.min(WALL_CONFIG.slots, SLOT_POSITIONS.length)),
  );

  const fresh = lastOkAt !== null && now - lastOkAt <= WALL_CONFIG.offlineGraceMs;
  const eligible = useMemo(
    () => (fresh && !revoked && feed?.mode === "live" ? feed.photos.map((p) => p.id) : []),
    [fresh, revoked, feed],
  );
  const allowed = useMemo(() => new Set(eligible), [eligible]);

  // Feed polling.
  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    async function poll() {
      // Only one request may be active. A slow earlier poll must never overwrite
      // a newer PAUSE WALL or SHOW HOLDING SCREEN response.
      if (stopped || inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(8_000, WALL_CONFIG.pollMs - 1_000));
      try {
        const res = await fetch("/api/wall/feed", { cache: "no-store", signal: controller.signal });
        if (stopped) return;
        if (res.status === 401) {
          setRevoked(true);
          setOnline(true);
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as WallFeed;
        if (stopped) return;
        setFeed(body);
        setRevoked(false);
        setOnline(true);
        setLastOkAt(Date.now());
      } catch {
        if (!stopped) setOnline(false);
      } finally {
        clearTimeout(timeout);
        inFlight = false;
      }
    }
    void poll();
    const id = setInterval(poll, WALL_CONFIG.pollMs);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  // Heartbeat, so staff can see the display in /admin → 키오스크.
  useEffect(() => {
    const beat = () =>
      fetch("/api/kiosk/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queueDepth: 0, camera: "unknown" }),
      }).catch(() => undefined);
    void beat();
    const id = setInterval(beat, WALL_CONFIG.heartbeatMs);
    return () => clearInterval(id);
  }, []);

  // Image cache: load what is newly eligible (one at a time), release what is not.
  const loading = useRef(new Set<string>());
  const allowedNow = useRef(allowed);
  useEffect(() => {
    allowedNow.current = allowed;
  }, [allowed]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setImages((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [id, url] of prev) {
          if (!allowed.has(id)) {
            URL.revokeObjectURL(url);
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      for (const id of eligible) {
        if (cancelled) return;
        if (images.has(id) || loading.current.has(id)) continue;
        loading.current.add(id);
        try {
          const res = await fetch(`/api/wall/photos/${id}/image`, { cache: "no-store" });
          if (!res.ok) continue;
          const blob = await res.blob();
          // Eligibility can change while the request is in flight. Never cache a
          // withdrawn photo, even if React schedules this state update later.
          if (cancelled || !allowedNow.current.has(id)) continue;
          const url = URL.createObjectURL(blob);
          setImages((prev) => {
            if (cancelled || !allowedNow.current.has(id) || prev.has(id)) {
              URL.revokeObjectURL(url);
              return prev;
            }
            return new Map(prev).set(id, url);
          });
        } catch {
          // Network hiccup: the next feed poll retries.
        } finally {
          loading.current.delete(id);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `images` is read only to skip work already done; reacting to it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, allowed]);

  // Scheduler tick.
  const latest = useRef({ eligible, images });
  useEffect(() => {
    latest.current = { eligible, images };
  });
  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      setSchedule((s) =>
        stepSchedule(s, {
          now: t,
          eligible: latest.current.eligible,
          ready: new Set(latest.current.images.keys()),
          timings: WALL_CONFIG,
        }),
      );
    }, WALL_CONFIG.tickMs);
    return () => clearInterval(id);
  }, []);

  const screen = wallScreenState({
    booted: feed !== null || revoked,
    online,
    maintenance: revoked || (feed !== null && feed.mode !== "live"),
    approvedCount: eligible.length,
  });

  return (
    <main
      data-testid="wall"
      data-wall-state={screen}
      data-wall-mode={revoked ? "revoked" : (feed?.mode ?? "boot")}
      className="night-sky relative flex h-dvh w-full cursor-none flex-col items-center justify-end overflow-hidden pb-[12vh]"
    >
      {schedule.slots.map((slot, i) => {
        const url = slot.photoId && allowed.has(slot.photoId) ? images.get(slot.photoId) : null;
        if (!slot.photoId || !slot.phase || !url) return null;
        const pos = SLOT_POSITIONS[i]!;
        return (
          <figure
            key={`${i}-${slot.photoId}`}
            data-testid="wall-photo"
            data-photo-id={slot.photoId}
            data-phase={slot.phase}
            className={`wall-photo absolute ${slot.phase === "EXIT" ? "wall-photo-exit" : "wall-photo-enter"}`}
            style={{
              left: `${pos.left}%`,
              top: `${pos.top}%`,
              transform: `translateX(-50%) rotate(${pos.tilt}deg)`,
            }}
          >
            {/* Object URL of bytes from our own server; next/image cannot optimise blob: URLs. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt=""
              className="max-h-[34vh] max-w-[15vw] rounded-md object-contain shadow-[0_0_40px_rgba(255,207,138,0.45)]"
            />
          </figure>
        );
      })}

      <div className="flex gap-[3vw]" aria-hidden>
        {Array.from({ length: HOUSES }, (_, i) => (
          <div
            key={i}
            className="rounded-t-md bg-dusk"
            style={{ width: "6vw", height: `${10 + ((i * 37) % 9)}vh` }}
          >
            <div className="mx-auto mt-[2vh] h-[3vh] w-[2.5vw] rounded-sm bg-amber/70 shadow-[0_0_30px_rgba(255,207,138,0.6)]" />
          </div>
        ))}
      </div>

      {feed?.mode === "holding" && !revoked ? (
        <div
          data-testid="wall-holding"
          className="absolute inset-0 flex flex-col items-center justify-center gap-[3vh] bg-ink/80 text-center"
        >
          <p className="text-[2.2vw] tracking-[0.3em] text-amber">FOLLOW THE LIGHTS</p>
          <p className="text-[3.2vw] font-bold text-cream">잠시 후 다시 불을 밝힐게요</p>
        </div>
      ) : (
        <p className="mt-[6vh] text-[2.2vw] tracking-[0.3em] text-amber">FOLLOW THE LIGHTS</p>
      )}

      {screen === "EMPTY" && (
        <p data-testid="wall-empty" className="mt-[2vh] text-[1.4vw] text-mist">
          사진을 찍고 미디어월에 함께해 주세요
        </p>
      )}

      {revoked && (
        <p
          data-testid="wall-revoked"
          className="absolute top-[3vh] right-[3vw] text-[1vw] text-mist"
        >
          STAFF · 이 화면의 등록이 해제됐어요
        </p>
      )}
      {!online && !revoked && (
        <p
          data-testid="wall-offline"
          className="absolute top-[3vh] right-[3vw] text-[1vw] text-mist"
        >
          STAFF · 연결 확인 중
        </p>
      )}
    </main>
  );
}
