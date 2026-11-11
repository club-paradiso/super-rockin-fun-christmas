"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { WALL_CONFIG } from "@/config/wall";
import { MOBILE_FRAME_ID } from "@/config/mobile";
import { PHONE_CARD, phoneCardBox, wallLayout } from "@/lib/wall/layout";
import { emptySchedule, stepSchedule, type WallSchedule } from "@/lib/wall/scheduler";
import { wallScreenState, type WallFeed } from "@/lib/wall/states";
import { msUntilDaily, shouldReload } from "@/lib/wall/watchdog";
import { Clip, WallScene } from "./wall-scene";

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
  /** The LED's input size (WALL_CANVAS / ?canvas=); null = this screen. The scene is fitted into it. */
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
  // The Figma scene has a fixed size and fixed slots; low-spec mode leaves the middle one empty.
  const layout = useMemo(
    () => wallLayout(WALL_CONFIG.scene, lite ? WALL_CONFIG.liteSlots : undefined),
    [lite],
  );
  const slotCount = layout.slots.length;
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

  // Frames drawn since the last heartbeat (frame rate for /admin → 키오스크).
  const frames = useRef({ count: 0, since: 0 });

  // Watchdog (docs/ARCHITECTURE.md 1.8): reload if drawing stalls or an error escapes, at most
  // once a minute; plus one planned reload a day.
  useEffect(() => {
    let lastFrameAt = Date.now();
    let errored = false;
    let raf = 0;
    const frame = () => {
      lastFrameAt = Date.now();
      frames.current.count++;
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
  // Which photos came from a guest's phone (D66): they hang as a card instead of a strip.
  const phonePhotos = useMemo(
    () =>
      new Set(
        feed?.mode === "live"
          ? feed.photos.filter((p) => p.frameId === MOBILE_FRAME_ID).map((p) => p.id)
          : [],
      ),
    [feed],
  );
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

  // Heartbeat, so staff can see the display in /admin → 키오스크, with its frame rate and (in
  // Chromium) JS memory: the numbers a long run is judged by (docs/ARCHITECTURE.md 1.8).
  useEffect(() => {
    frames.current = { count: 0, since: Date.now() };
    const beat = () => {
      const t = Date.now();
      const { count, since } = frames.current;
      frames.current = { count: 0, since: t };
      const seconds = (t - since) / 1000;
      const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
      return fetch("/api/kiosk/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queueDepth: 0,
          camera: "unknown",
          frameRate: seconds >= 1 ? Math.round((count / seconds) * 10) / 10 : null,
          memoryMb: heap ? Math.round(heap.usedJSHeapSize / 1_048_576) : null,
        }),
      }).catch(() => undefined);
    };
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

  const unit = layout.height / 1000;
  // The scene is fitted into the screen; with WALL_CANVAS / ?canvas= into a box of the LED's input
  // shape first (to see the letterboxing on another monitor).
  const stage = canvas ?? viewport;
  const scale =
    stage && viewport
      ? Math.min(stage.width / layout.width, stage.height / layout.height) *
        (canvas ? Math.min(viewport.width / canvas.width, viewport.height / canvas.height) : 1)
      : 1;

  return (
    <main
      data-testid="wall"
      data-wall-state={screen}
      data-wall-mode={revoked ? "revoked" : (feed?.mode ?? "boot")}
      className="wall-stage relative h-dvh w-full cursor-none overflow-hidden"
    >
      {viewport && (
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
                  className="absolute inset-0 flex flex-col items-center justify-center bg-(--wall-night)/85 text-center"
                  style={{ gap: unit * 30 }}
                >
                  <p
                    className="text-(--wall-amber)"
                    style={{ fontSize: unit * 44, letterSpacing: "0.3em" }}
                  >
                    STUDIO SHALOM
                  </p>
                  <p className="font-bold text-(--wall-cream)" style={{ fontSize: unit * 64 }}>
                    잠시 후 다시 불을 밝힐게요
                  </p>
                </div>
              ) : feed?.mode === "closed" && !revoked ? (
                <div
                  data-testid="wall-closed"
                  className="absolute inset-0 flex flex-col items-center justify-center bg-(--wall-night)/70 text-center"
                  style={{ gap: unit * 30 }}
                >
                  <p className="font-bold text-(--wall-cream)" style={{ fontSize: unit * 60 }}>
                    오늘의 미디어월은 여기까지예요
                  </p>
                  {feed.opensAt && (
                    <p className="text-(--wall-amber)" style={{ fontSize: unit * 40 }}>
                      {feed.opensAt}에 다시 불을 밝힐게요
                    </p>
                  )}
                </div>
              ) : screen === "EMPTY" ? (
                <p
                  data-testid="wall-empty"
                  className="absolute w-full text-center text-(--wall-cream)/80"
                  style={{
                    top: WALL_CONFIG.scene.line.y0 + unit * 260,
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
              if (phonePhotos.has(slot.photoId)) {
                const card = phoneCardBox(place);
                return (
                  <figure
                    key={`${i}-${slot.photoId}`}
                    data-testid="wall-photo"
                    data-photo-id={slot.photoId}
                    data-phase={slot.phase}
                    data-kind="phone"
                    className="absolute"
                    style={{
                      left: card.x,
                      top: place.y,
                      width: card.width,
                      height: card.height + (card.y - place.y),
                      transform: `rotate(${place.tilt}deg)`,
                      transformOrigin: "50% 0",
                    }}
                  >
                    <div
                      className={`relative h-full w-full ${slot.phase === "EXIT" ? "wall-photo-exit" : "wall-photo-enter"}`}
                    >
                      <Clip dropToStrip={card.y - place.y} />
                      <div
                        className="absolute inset-x-0 bottom-0 flex flex-col bg-(--wall-card)"
                        style={{
                          top: card.y - place.y,
                          padding: `${PHONE_CARD.margin}px ${PHONE_CARD.margin}px 0`,
                          boxShadow: "0 12px 24px rgba(0,0,0,0.55)",
                        }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element -- blob: URL from our server */}
                        <img
                          src={url}
                          alt=""
                          data-testid="wall-photo-image"
                          className="w-full bg-(--wall-card-mat) object-contain"
                          style={{ height: PHONE_CARD.photoHeight }}
                        />
                        <p
                          className="flex flex-1 items-center justify-center font-bold text-(--wall-card-ink)"
                          style={{ fontSize: 17, letterSpacing: "0.24em" }}
                        >
                          STUDIO SHALOM
                        </p>
                      </div>
                    </div>
                  </figure>
                );
              }
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
                    <Clip dropToStrip={place.box.y - place.y} />
                    {/* Object URL of bytes from our own server; next/image cannot optimise blob: URLs. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt=""
                      data-testid="wall-photo-image"
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
          className="absolute top-[3vh] right-[3vw] text-[1vw] text-(--wall-mist)"
        >
          STAFF · 이 화면의 등록이 해제됐어요
        </p>
      )}
      {!online && !revoked && (
        <p
          data-testid="wall-offline"
          className="absolute top-[3vh] right-[3vw] text-[1vw] text-(--wall-mist)"
        >
          STAFF · 연결 확인 중
        </p>
      )}
    </main>
  );
}
