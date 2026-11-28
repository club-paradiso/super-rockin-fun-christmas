"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { WALL_CONFIG } from "@/config/wall";
import { DEFAULT_WALL_THEME, getWallTheme } from "@/config/wall-themes";
import { fitTheme, wallPhotoShadow } from "@/lib/wall/themes";
import { planWallFit } from "@/lib/wall/fit";
import { framedPhotoFrame, MOBILE_FRAME_ID } from "@/config/mobile";
import { PHONE_CARD, framedPhotoBox, phoneCardBox, wallLayout } from "@/lib/wall/layout";
import { ageWeight } from "@/lib/wall/rotation";
import { emptySchedule, stepSchedule, type WallSchedule } from "@/lib/wall/scheduler";
import { wallScreenState, type WallFeed } from "@/lib/wall/states";
import { msUntilDaily, shouldReload } from "@/lib/wall/watchdog";
import { Clip, WallScene } from "./wall-scene";
import { WallFullscreenButton, useFullscreenButton } from "./fullscreen-button";
import { enterWallFullscreen } from "@/lib/wall/fullscreen";
import { WallCheck } from "./wall-check";

const RELOAD_KEY = "ftl-wall-reloaded-at";

/**
 * Reload the page, remembering when, so the watchdog never loops faster than once a minute.
 * Only when the server answers: a reload while the hub cannot be reached leaves the browser's own
 * "cannot connect" page, which nothing brings back (and inside a show program nobody sees why).
 * False = not reloaded; the caller tries again later.
 */
let reloading = false;
async function reloadPage(): Promise<boolean> {
  if (reloading) return false;
  reloading = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(window.location.href, {
      method: "HEAD",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
    reloading = false;
  }
  try {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // Storage unavailable: the reload still helps.
  }
  window.location.reload();
  return true;
}

interface ScreenSize {
  width: number;
  height: number;
}

/**
 * The wall's own size in CSS px, kept current through everything that changes it: window resizes,
 * entering and leaving fullscreen, the window moving to another monitor, rotation, the iPad/phone
 * address bar (visual viewport). Measured
 * on the wall element itself, once per animation frame at most, and only set when it changed.
 * A host that draws the page off screen may not run animation frames (lib/wall/embed.ts), so a
 * short timer measures when the frame does not come, and a slow one catches a size change that
 * sent no event at all: the wall must never keep the shape of a size it no longer has.
 * Null until mounted, so the server render and the first client render agree.
 */
function useScreenSize(ref: React.RefObject<HTMLElement | null>): ScreenSize | null {
  const [size, setSize] = useState<ScreenSize | null>(null);
  useEffect(() => {
    let raf = 0;
    let timer = 0;
    const read = () => {
      if (raf) cancelAnimationFrame(raf);
      if (timer) window.clearTimeout(timer);
      raf = 0;
      timer = 0;
      const el = ref.current;
      const rect = el?.getBoundingClientRect();
      const width = Math.round(rect?.width || window.innerWidth);
      const height = Math.round(rect?.height || window.innerHeight);
      setSize((prev) =>
        prev && prev.width === width && prev.height === height ? prev : { width, height },
      );
    };
    const schedule = () => {
      if (raf || timer) return;
      raf = requestAnimationFrame(read);
      timer = window.setTimeout(read, 250);
    };
    read();
    const slow = window.setInterval(schedule, 2_000);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    if (ref.current) observer?.observe(ref.current);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    document.addEventListener("fullscreenchange", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (timer) window.clearTimeout(timer);
      window.clearInterval(slow);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      document.removeEventListener("fullscreenchange", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, [ref]);
  return size;
}

/**
 * The media wall. Polls /api/wall/feed, keeps eligible images in memory (object URLs) and lets
 * the pure scheduler decide what enters and leaves, in the hub's fair rotation order. Anything
 * the server stops listing disappears on the same render; after WALL_CONFIG.offlineGraceMs
 * without a successful poll every cached photo is dropped, because the wall can no longer learn
 * about hides or deletions.
 *
 * The page needs no enrollment (D86). The feed says who this screen is: an enrolled venue
 * `display` also sends a heartbeat and reports each photo it puts up (/api/wall/shown, the
 * exposure log the rotation is built on); the `public` audience only reads. The feed also names
 * the background theme (D85), so staff change it for every screen at once.
 */
export function WallApp({
  canvas = null,
  lite = false,
  initialTheme = DEFAULT_WALL_THEME,
  embed = false,
  check = false,
  minPhotos = 0,
}: {
  /** ?photos=N: hang at least this many on this screen (0 = the fit decides). */
  minPhotos?: number;
  /** Inside another program's web view (?embed=1, lib/wall/embed.ts): no fullscreen, no frame watchdog. */
  embed?: boolean;
  /** Staff check (?check=1): numbers over the wall. */
  check?: boolean;
  /** The LED's input size (WALL_CANVAS / ?canvas=); null = this screen. The scene is fitted into it. */
  canvas?: { width: number; height: number } | null;
  /** Low-spec mode: fades only, fewer photos. */
  lite?: boolean;
  /** The theme at page load; the feed takes over from the first poll. */
  initialTheme?: string;
}) {
  const mainRef = useRef<HTMLElement>(null);
  const viewport = useScreenSize(mainRef);
  // 전체화면: the button, a double-click or F go in; only Escape (the browser's own) comes out.
  // Inside another program fullscreen is that program's: no button, no key, no double-click.
  const showFullscreenButton = useFullscreenButton(!embed);
  useEffect(() => {
    if (embed) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey && !e.altKey)
        enterWallFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [embed]);
  const [feed, setFeed] = useState<WallFeed | null>(null);
  // Screen-adaptive fit (D110): the wall measures the screen it is on (or the LED's input size,
  // WALL_CANVAS / ?canvas=) and lib/wall/fit.ts picks the theme's cut (D91), the run of slots and
  // the scale that hang the photos as large as this screen allows, the picture covering the screen.
  const themeId = feed?.theme ?? initialTheme;
  const shape = canvas ?? viewport;
  const aspect = shape ? shape.width / shape.height : null;
  const baseTheme = useMemo(() => getWallTheme(themeId), [themeId]);
  // The plan on screen wins near-ties, so resizing a window does not flip between two plans.
  // Kept as state: when a new plan wins it is stored, and the next render confirms it.
  const [planKey, setPlanKey] = useState<string | null>(null);
  const plan = useMemo(
    () =>
      shape
        ? planWallFit(
            baseTheme,
            { width: shape.width, height: shape.height },
            {
              lite,
              prefer: planKey,
              minSlots: minPhotos,
            },
          )
        : null,
    [baseTheme, shape, lite, planKey, minPhotos],
  );
  if (plan && plan.key !== planKey) setPlanKey(plan.key);
  // Before the first measurement: the closest cut, every slot (only for the server render).
  const theme = useMemo(
    () => plan?.theme ?? fitTheme(baseTheme, aspect),
    [plan, baseTheme, aspect],
  );
  const layout = useMemo(
    () => plan?.layout ?? wallLayout(theme.scene, lite ? theme.liteSlots : undefined),
    [plan, theme, lite],
  );
  const slotCount = layout.slots.length;
  const slotsRef = useRef(slotCount);
  // Only an enrolled venue display reports back (heartbeat, exposure log).
  const isDisplay = feed?.audience === "display";

  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [online, setOnline] = useState(true);
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
          watchFrames: !embed,
        })
      )
        void reloadPage();
      errored = false;
    }, 2_000);
    // The planned reload waits for the server: tried again every minute until it answers.
    let daily = setTimeout(
      function planned() {
        void reloadPage().then((done) => {
          if (!done) daily = setTimeout(planned, 60_000);
        });
      },
      msUntilDaily(new Date(), WALL_CONFIG.watchdog.dailyReloadAt),
    );
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(check);
      clearTimeout(daily);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onError);
    };
  }, [embed]);

  const fresh = lastOkAt !== null && now - lastOkAt <= WALL_CONFIG.offlineGraceMs;
  const eligible = useMemo(
    () => (fresh && feed?.mode === "live" ? feed.photos.map((p) => p.id) : []),
    [fresh, feed],
  );
  const allowed = useMemo(() => new Set(eligible), [eligible]);
  // Plain phone photos (D66, no frame) hang as a card instead of a strip; framed ones (D93) do not.
  const phonePhotos = useMemo(
    () =>
      new Set(
        feed?.mode === "live"
          ? feed.photos.filter((p) => p.frameId === MOBILE_FRAME_ID).map((p) => p.id)
          : [],
      ),
    [feed],
  );
  // Booth photos by frame: a frame that is not a 1:3 strip hangs wider (D77).
  const photoFrames = useMemo(
    () => new Map(feed?.mode === "live" ? feed.photos.map((p) => [p.id, p.frameId]) : []),
    [feed],
  );
  const showNow = useMemo(
    () => new Set(fresh && feed?.mode === "live" ? feed.showNow : []),
    [fresh, feed],
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
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as WallFeed;
        if (stopped) return;
        setFeed(body);
        setOnline(true);
        setLastOkAt(Date.now());
        // The public audience never reports: the server would refuse it anyway.
        if (body.audience === "display") void report();
        else unreported.current = [];
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
    if (!isDisplay) return;
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
  }, [isDisplay]);

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
  // Staff pace (D92). An older server that sends none keeps the built-in timing.
  const visibleMs = feed?.pace?.visibleMs ?? WALL_CONFIG.visibleMs;
  const halfLifeMs = feed?.pace?.halfLifeMs ?? 0;
  const taken = useMemo(
    () => new Map((feed?.photos ?? []).map((p) => [p.id, Date.parse(p.createdAt)])),
    [feed],
  );
  const pace = { eligible, images, showNow, ordering: feed?.ordering ?? "fair" } as const;
  const latest = useRef({ ...pace, visibleMs, halfLifeMs, taken });
  useEffect(() => {
    latest.current = { ...pace, visibleMs, halfLifeMs, taken };
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
          timings: { ...WALL_CONFIG, visibleMs: latest.current.visibleMs },
          ordering: latest.current.ordering,
          showNow: latest.current.showNow,
          sharesKey: latest.current.halfLifeMs,
          weights: latest.current.halfLifeMs
            ? new Map(
                [...latest.current.taken].map(([id, at]) => [
                  id,
                  ageWeight(at, t, latest.current.halfLifeMs),
                ]),
              )
            : undefined,
        });
      });
    }, WALL_CONFIG.tickMs);
    return () => clearInterval(id);
  }, []);

  const screen = wallScreenState({
    booted: feed !== null,
    online,
    maintenance: feed !== null && feed.mode !== "live",
    approvedCount: eligible.length,
  });

  // The stage is what the plan was made for: the LED's input size with ?canvas= / WALL_CANVAS
  // (letterboxed into this monitor, to preview the LED), else this screen.
  const stage = canvas ?? viewport;
  const preview =
    canvas && viewport
      ? Math.min(viewport.width / canvas.width, viewport.height / canvas.height)
      : 1;
  const banded = plan
    ? {
        x: plan.bands.left + plan.bands.right > 0.5,
        y: plan.bands.top + plan.bands.bottom > 0.5,
      }
    : null;
  const hasBands = !!banded && (banded.x || banded.y);
  // The 2× picture only where the screen shows the scene enlarged (a 16:9 TV), never in low-spec
  // mode: it costs four times the memory.
  const hiDpi =
    !lite &&
    !!plan &&
    plan.scale * preview * (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1) >
      1.05;
  // Screen-relative text unit: what the scene unit was on the 3840 × 1080 LED (1.08 px), shrinking
  // with the screen, never so small a portrait screen cannot read it, never wider than the screen.
  const unit = stage
    ? Math.min(
        Math.max(
          Math.min(stage.height, stage.width * (1080 / 3840)),
          Math.min(stage.width, stage.height) * 0.9,
        ) / 1000,
        stage.width / 1100,
      )
    : 1;
  // The "empty wall" note where the theme puts it, kept on screen when the picture is cropped.
  const emptyTop =
    plan && stage
      ? Math.min(
          Math.max(plan.offset.y + plan.scale * theme.emptyTextY, stage.height * 0.06),
          stage.height * 0.86,
        )
      : 0;

  return (
    <main
      ref={mainRef}
      data-testid="wall"
      data-wall-state={screen}
      data-wall-mode={feed?.mode ?? "boot"}
      data-wall-audience={feed?.audience ?? "unknown"}
      data-fit={plan?.key ?? ""}
      data-fit-scale={plan ? plan.scale.toFixed(4) : ""}
      data-fit-coverage={plan ? plan.coverage.toFixed(4) : ""}
      data-wall-embed={embed ? "1" : undefined}
      style={{ background: theme.fallbackColor }}
      className={`wall-stage relative h-dvh w-full overflow-hidden ${showFullscreenButton ? "cursor-default" : "cursor-none"}`}
      onDoubleClick={embed ? undefined : () => enterWallFullscreen()}
    >
      {viewport && stage && plan && (
        <div
          data-testid="wall-stage-box"
          className="absolute overflow-hidden"
          style={{
            left: (viewport.width - stage.width * preview) / 2,
            top: (viewport.height - stage.height * preview) / 2,
            width: stage.width,
            height: stage.height,
            transform: preview === 1 ? undefined : `scale(${preview})`,
            transformOrigin: "0 0",
            background: theme.fallbackColor,
          }}
        >
          {hasBands && !lite && (
            // The same picture, blurred and dimmed, behind the bands the photos could not avoid.
            // eslint-disable-next-line @next/next/no-img-element -- static, same-origin, works offline
            <img
              key={theme.background}
              src={theme.background}
              alt=""
              aria-hidden
              data-testid="wall-ambient"
              className="wall-ambient absolute inset-0 h-full w-full object-cover"
            />
          )}
          <div
            className="absolute"
            style={{
              left: plan.offset.x,
              top: plan.offset.y,
              width: layout.width,
              height: layout.height,
              transform: `scale(${plan.scale})`,
              transformOrigin: "0 0",
            }}
          >
            <WallScene
              theme={theme}
              aspect={aspect}
              layout={layout}
              lite={lite}
              feather={banded}
              mark={plan.mark}
              hiDpi={hiDpi}
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
                        <Clip theme={theme} slot={i} />
                        <div
                          className="absolute inset-x-0 bottom-0 flex flex-col bg-(--wall-card)"
                          style={{
                            top: card.y - place.y,
                            padding: `${PHONE_CARD.margin}px ${PHONE_CARD.margin}px 0`,
                            boxShadow: wallPhotoShadow("box"),
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
                            className="flex flex-1 items-center justify-center text-(--wall-card-ink)"
                            role="img"
                            aria-label="STUDIO SHALOM"
                          >
                            <span className="wall-logo-mark" style={{ width: 102, height: 24 }} />
                          </p>
                        </div>
                      </div>
                    </figure>
                  );
                }
                // A phone photo put in a booth frame (D93) hangs exactly like that booth frame.
                const frame = framedPhotoFrame(photoFrames.get(slot.photoId) ?? "");
                const box =
                  framedPhotoBox(
                    place,
                    { width: frame.outputWidth, height: frame.outputHeight },
                    theme.wideMax,
                  ) ?? place.box;
                return (
                  <figure
                    key={`${i}-${slot.photoId}`}
                    data-testid="wall-photo"
                    data-photo-id={slot.photoId}
                    data-phase={slot.phase}
                    data-frame-id={frame.id}
                    className="absolute"
                    style={{
                      left: box.x,
                      top: place.y,
                      width: box.width,
                      height: box.height + (box.y - place.y),
                      transform: `rotate(${place.tilt}deg)`,
                      transformOrigin: "50% 0",
                    }}
                  >
                    <div
                      className={`relative h-full w-full ${slot.phase === "EXIT" ? "wall-photo-exit" : "wall-photo-enter"}`}
                    >
                      <Clip theme={theme} slot={i} />
                      {/* Object URL of bytes from our own server; next/image cannot optimise blob: URLs. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={url}
                        alt=""
                        data-testid="wall-photo-image"
                        className="h-full w-full object-contain object-top"
                        style={{
                          paddingTop: box.y - place.y,
                          filter: wallPhotoShadow("filter"),
                        }}
                      />
                    </div>
                  </figure>
                );
              })}
            </WallScene>
          </div>
          {feed?.mode === "holding" ? (
            <div
              data-testid="wall-holding"
              className="absolute inset-0 flex flex-col items-center justify-center bg-(--wall-night)/85 text-center"
              style={{ gap: unit * 30 }}
            >
              <p
                className="text-(--wall-amber)"
                role="img"
                aria-label="STUDIO SHALOM"
                style={{ width: unit * 340, height: unit * 80 }}
              >
                <span className="wall-logo-mark" />
              </p>
              <p className="font-bold text-(--wall-cream)" style={{ fontSize: unit * 64 }}>
                잠시만 기다려주세요!
              </p>
            </div>
          ) : feed?.mode === "closed" ? (
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
              className="wall-note absolute"
              style={{ top: emptyTop, fontSize: unit * 40 }}
            >
              사진을 찍고 미디어월에 함께해 주세요
            </p>
          ) : null}
        </div>
      )}

      {!online && (
        <p
          data-testid="wall-offline"
          className="absolute top-[3vh] right-[3vw] text-[1vw] text-(--wall-mist)"
        >
          STAFF · 연결 확인 중
        </p>
      )}
      {showFullscreenButton && <WallFullscreenButton />}
      {check && viewport && (
        <WallCheck
          viewport={viewport}
          canvas={canvas}
          embed={embed}
          fit={plan?.key ?? null}
          places={slotCount}
          minPhotos={minPhotos}
          audience={feed?.audience ?? null}
          mode={feed?.mode ?? null}
          online={online}
          answeredSecondsAgo={
            lastOkAt === null ? null : Math.max(0, Math.round((now - lastOkAt) / 1000))
          }
          eligible={eligible.length}
          loaded={images.size}
          hanging={schedule.slots.filter((s) => s.photoId).length}
          now={now}
        />
      )}
    </main>
  );
}
