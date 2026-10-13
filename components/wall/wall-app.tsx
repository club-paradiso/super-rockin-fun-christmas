"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { WALL_CONFIG } from "@/config/wall";
import { clotheslineLayout } from "@/lib/wall/layout";
import { emptySchedule, stepSchedule, type WallSchedule } from "@/lib/wall/scheduler";
import { wallScreenState, type WallFeed } from "@/lib/wall/states";
import { msUntilDaily, shouldReload } from "@/lib/wall/watchdog";
import { Peg, WallScene } from "./wall-scene";

const RELOAD_KEY = "ftl-wall-reloaded-at";

/** Reload the page, remembering when, so the watchdog never loops faster than once a minute. */
function reloadPage() {
  try {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // Storage unavailable: the reload still helps.
  }
  window.location.reload();
}

/**
 * The media wall. Polls /api/wall/feed, keeps eligible images in memory (object URLs) and lets
 * the pure scheduler decide what enters and leaves, in the hub's fair rotation order. Anything
 * the server stops listing disappears on the same render; after WALL_CONFIG.offlineGraceMs
 * without a successful poll every cached photo is dropped, because the wall can no longer learn
 * about hides or deletions. Each photo it puts up is reported back (/api/wall/shown), which is
 * the exposure log the rotation is built on.
 */
export function WallApp({
  canvas = null,
  lite = false,
}: {
  /** Fixed scene size (WALL_CANVAS / ?canvas=); null = the screen's own size. */
  canvas?: { width: number; height: number } | null;
  /** Low-spec mode: fades only, no twinkling, fewer photos. */
  lite?: boolean;
}) {
  // Measured after mount, so the server render and the first client render agree.
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const measure = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const size = canvas ?? viewport;
  const layout = useMemo(
    () =>
      size &&
      clotheslineLayout(
        size,
        WALL_CONFIG.scene,
        lite ? Math.min(WALL_CONFIG.liteMaxSlots, WALL_CONFIG.scene.maxSlots) : undefined,
      ),
    [size, lite],
  );
  const slotCount = layout?.slots.length ?? 0;
  const slotsRef = useRef(slotCount);

  const [feed, setFeed] = useState<WallFeed | null>(null);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [online, setOnline] = useState(true);
  const [revoked, setRevoked] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [images, setImages] = useState<ReadonlyMap<string, string>>(new Map());
  const [schedule, setSchedule] = useState<WallSchedule>(() => emptySchedule(0));
  // The scene decides how many photos hang at once; the next tick starts a fresh line if the
  // shape changed (lib/wall/scheduler.ts works on a fixed number of slots).
  useEffect(() => {
    slotsRef.current = slotCount;
  }, [slotCount]);

  // Watchdog (docs/ARCHITECTURE.md 1.8): reload if drawing stalls or an error escapes, at most
  // once a minute; plus one planned reload a day.
  useEffect(() => {
    let lastFrameAt = Date.now();
    let errored = false;
    let raf = 0;
    const frame = () => {
      lastFrameAt = Date.now();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const onError = () => {
      errored = true;
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onError);
    const check = setInterval(() => {
      let lastReloadAt: number | null = null;
      try {
        lastReloadAt = Number(sessionStorage.getItem(RELOAD_KEY)) || null;
      } catch {}
      if (
        shouldReload({
          now: Date.now(),
          lastFrameAt,
          visible: document.visibilityState === "visible",
          errored,
          lastReloadAt,
          stallMs: WALL_CONFIG.watchdog.stallMs,
          minReloadGapMs: WALL_CONFIG.watchdog.minReloadGapMs,
        })
      )
        reloadPage();
      errored = false;
    }, 2_000);
    const daily = setTimeout(
      reloadPage,
      msUntilDaily(new Date(), WALL_CONFIG.watchdog.dailyReloadAt),
    );
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(check);
      clearTimeout(daily);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onError);
    };
  }, []);

  const fresh = lastOkAt !== null && now - lastOkAt <= WALL_CONFIG.offlineGraceMs;
  const eligible = useMemo(
    () => (fresh && !revoked && feed?.mode === "live" ? feed.photos.map((p) => p.id) : []),
    [fresh, revoked, feed],
  );
  const allowed = useMemo(() => new Set(eligible), [eligible]);
  const showNow = useMemo(
    () => new Set(fresh && !revoked && feed?.mode === "live" ? feed.showNow : []),
    [fresh, revoked, feed],
  );

  // What is on screen right now, and what went up since the last report (read by the poller).
  const onWallRef = useRef<string[]>([]);
  const unreported = useRef<string[]>([]);
  useEffect(() => {
    const ids = schedule.slots.map((s) => s.photoId).filter((id): id is string => !!id);
    for (const slot of schedule.slots) {
      if (slot.photoId && slot.phase === "ENTER" && !onWallRef.current.includes(slot.photoId))
        unreported.current = [...unreported.current, slot.photoId].slice(-50);
    }
    onWallRef.current = ids;
  }, [schedule]);

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
      const timeout = setTimeout(
        () => controller.abort(),
        Math.min(8_000, WALL_CONFIG.pollMs - 1_000),
      );
      try {
        const q = new URLSearchParams();
        if (onWallRef.current.length) q.set("on", onWallRef.current.join(","));
        if (slotsRef.current) q.set("slots", String(slotsRef.current));
        const res = await fetch(`/api/wall/feed?${q}`, {
          cache: "no-store",
          signal: controller.signal,
        });
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
        void report();
      } catch {
        if (!stopped) setOnline(false);
      } finally {
        clearTimeout(timeout);
        inFlight = false;
      }
    }
    /** Exposure report. Unsent entries are kept (max 50) and retried with the next poll. */
    async function report() {
      const shown = unreported.current;
      try {
        const res = await fetch("/api/wall/shown", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ shown, onWall: onWallRef.current }),
        });
        if (res.ok) unreported.current = unreported.current.slice(shown.length);
      } catch {
        // Retried after the next successful poll.
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
  const latest = useRef({ eligible, images, showNow, ordering: feed?.ordering ?? "fair" });
  useEffect(() => {
    latest.current = { eligible, images, showNow, ordering: feed?.ordering ?? "fair" };
  });
  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      setSchedule((prev) => {
        const s = prev.slots.length === slotsRef.current ? prev : emptySchedule(slotsRef.current);
        return stepSchedule(s, {
          now: t,
          eligible: latest.current.eligible,
          ready: new Set(latest.current.images.keys()),
          timings: WALL_CONFIG,
          ordering: latest.current.ordering,
          showNow: latest.current.showNow,
        });
      });
    }, WALL_CONFIG.tickMs);
    return () => clearInterval(id);
  }, []);

  const screen = wallScreenState({
    booted: feed !== null || revoked,
    online,
    maintenance: revoked || (feed !== null && feed.mode !== "live"),
    approvedCount: eligible.length,
  });

  const unit = (layout?.height ?? 1000) / 1000;
  const scale =
    layout && viewport
      ? Math.min(viewport.width / layout.width, viewport.height / layout.height)
      : 1;

  return (
    <main
      data-testid="wall"
      data-wall-state={screen}
      data-wall-mode={revoked ? "revoked" : (feed?.mode ?? "boot")}
      className="relative h-dvh w-full cursor-none overflow-hidden bg-[#0b0806]"
    >
      {layout && viewport && (
        <div
          className="absolute"
          style={{
            left: (viewport.width - layout.width * scale) / 2,
            top: (viewport.height - layout.height * scale) / 2,
            width: layout.width,
            height: layout.height,
            transform: `scale(${scale})`,
            transformOrigin: "0 0",
          }}
        >
          <WallScene
            layout={layout}
            lite={lite}
            overlay={
              feed?.mode === "holding" && !revoked ? (
                <div
                  data-testid="wall-holding"
                  className="absolute inset-0 flex flex-col items-center justify-center bg-ink/85 text-center"
                  style={{ gap: unit * 30 }}
                >
                  <p className="text-amber" style={{ fontSize: unit * 44, letterSpacing: "0.3em" }}>
                    FOLLOW THE LIGHTS
                  </p>
                  <p className="font-bold text-cream" style={{ fontSize: unit * 64 }}>
                    잠시 후 다시 불을 밝힐게요
                  </p>
                </div>
              ) : screen === "EMPTY" ? (
                <p
                  data-testid="wall-empty"
                  className="absolute w-full text-center text-cream/80"
                  style={{
                    top: layout.line.y0 + layout.line.sag + unit * 120,
                    fontSize: unit * 40,
                  }}
                >
                  사진을 찍고 미디어월에 함께해 주세요
                </p>
              ) : null
            }
          >
            {schedule.slots.map((slot, i) => {
              const place = layout.slots[i];
              const url =
                slot.photoId && allowed.has(slot.photoId) ? images.get(slot.photoId) : null;
              if (!place || !slot.photoId || !slot.phase || !url) return null;
              return (
                <figure
                  key={`${i}-${slot.photoId}`}
                  data-testid="wall-photo"
                  data-photo-id={slot.photoId}
                  data-phase={slot.phase}
                  className="absolute"
                  style={{
                    left: place.box.x,
                    top: place.y,
                    width: place.box.width,
                    height: place.box.height + (place.box.y - place.y),
                    transform: `rotate(${place.tilt}deg)`,
                    transformOrigin: "50% 0",
                  }}
                >
                  <div
                    className={`relative h-full w-full ${slot.phase === "EXIT" ? "wall-photo-exit" : "wall-photo-enter"}`}
                  >
                    <Peg unit={unit} />
                    {/* Object URL of bytes from our own server; next/image cannot optimise blob: URLs. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt=""
                      className="h-full w-full object-contain object-top"
                      style={{
                        paddingTop: place.box.y - place.y,
                        filter: "drop-shadow(0 12px 24px rgba(0,0,0,0.55))",
                      }}
                    />
                  </div>
                </figure>
              );
            })}
          </WallScene>
        </div>
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
