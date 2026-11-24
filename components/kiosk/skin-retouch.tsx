"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { RETOUCH_CONFIG, type RetouchLevelId } from "@/config/retouch";
import type { ComposeImage } from "@/lib/compositor/types";
import type { PhotoStage } from "@/lib/kiosk/photo-stages";
import type { SkinRetoucher } from "@/lib/retouch/pipeline";
import type { BatchMetrics, RetouchErrorCode } from "@/lib/retouch/types";

/**
 * The booth's side of skin retouch: the "skin-retouch" photo stage (lib/kiosk/photo-stages.ts).
 * With the level "off" (the default) nothing is loaded at all. Otherwise the module and the face
 * model are fetched from this server while the booth waits for a guest, and the chosen photos are
 * retouched on this device right before the frame is made. A photo that fails or takes too long
 * goes on as it was shot; the failure goes to the console and, with the next heartbeat, to the
 * server log (a code and a count, never anything about a face).
 */
export function useSkinRetouch(level: RetouchLevelId) {
  const active = level !== "off";
  const retoucherRef = useRef<Promise<SkinRetoucher> | null>(null);
  const failuresRef = useRef<{ count: number; last: RetouchErrorCode | null }>({
    count: 0,
    last: null,
  });
  const [developing, setDeveloping] = useState(false);
  const [metrics, setMetrics] = useState<BatchMetrics | null>(null);

  useEffect(() => {
    if (!active) return;
    const load = (retoucherRef.current ??= import("@/lib/retouch/browser").then((m) =>
      m.createBrowserRetoucher({
        onError: (code) => {
          failuresRef.current = { count: failuresRef.current.count + 1, last: code };
        },
      }),
    ));
    // Before the first guest: the model is there when the first print needs it.
    void load.then((retoucher) => retoucher.warmUp()).catch(() => undefined);
    return () => {
      retoucherRef.current = null;
      void load.then((retoucher) => retoucher.dispose()).catch(() => undefined);
    };
  }, [active]);

  const stage = useMemo<PhotoStage | null>(() => {
    if (!active) return null;
    return {
      async run(images) {
        const load = retoucherRef.current;
        if (!load) return { images: images.slice(), release: () => undefined };
        setDeveloping(true);
        try {
          const retoucher = await load;
          const { results, metrics: batch } = await retoucher.retouchBatch(images, level);
          setMetrics(batch);
          return {
            images: results.map((r) => r.image as ComposeImage),
            release: () => {
              for (const r of results)
                if (r.retouched) {
                  const canvas = r.image.source as { width: number; height: number };
                  canvas.width = canvas.height = 0;
                }
            },
          };
        } catch (error) {
          // The module itself did not load (the server was unreachable): say so, go on.
          console.error("[skin-retouch] init-failed:", error);
          failuresRef.current = { count: failuresRef.current.count + 1, last: "init-failed" };
          return { images: images.slice(), release: () => undefined };
        } finally {
          setDeveloping(false);
        }
      },
    };
  }, [active, level]);

  return {
    stage,
    /** True while the chosen photos are being retouched ("현상 중…"). */
    developing,
    metrics,
    /** For the heartbeat: failures since the last call, then counted from zero again. */
    takeFailures(): { retouchFailures: number; retouchError: RetouchErrorCode } | null {
      const { count, last } = failuresRef.current;
      if (count === 0 || !last) return null;
      failuresRef.current = { count: 0, last: null };
      return { retouchFailures: count, retouchError: last };
    },
  };
}

/** Timings of the last print's retouch, for whoever is measuring the device. Not a guest view. */
export function RetouchHud({ metrics }: { metrics: BatchMetrics | null }) {
  const sum = (pick: (p: BatchMetrics["photos"][number]) => number) =>
    Math.round(metrics?.photos.reduce((total, p) => total + pick(p), 0) ?? 0);
  return (
    <aside
      data-testid="retouch-hud"
      aria-hidden
      style={{
        position: "fixed",
        left: 8,
        bottom: 8,
        zIndex: 50,
        padding: "6px 10px",
        borderRadius: 6,
        background: "rgba(0, 0, 0, 0.78)",
        color: "#fff",
        font: "12px/1.5 ui-monospace, Menlo, monospace",
        pointerEvents: "none",
        whiteSpace: "pre",
      }}
    >
      {metrics
        ? [
            `피부 보정 ${metrics.photos.length}장 합계 ${Math.round(metrics.totalMs)} ms (목표 ${RETOUCH_CONFIG.budget.targetTotalMs})`,
            `검출 ${sum((p) => p.detectMs)} ms · 보정 ${sum((p) => p.filterMs)} ms · 모델 올리기 ${Math.round(metrics.initMs)} ms`,
            `장당 ${metrics.photos.map((p) => Math.round(p.totalMs)).join(" / ")} ms`,
            `얼굴 ${metrics.photos.map((p) => `${p.facesRetouched}/${p.facesFound}`).join(" ")} · 엔진 ${metrics.photos.find((p) => p.engine)?.engine ?? "-"}`,
            `메모리 추정 ${(metrics.peakBytes / 1048576).toFixed(1)} MB${metrics.jsHeapBytes === null ? "" : ` · JS 힙 ${(metrics.jsHeapBytes / 1048576).toFixed(0)} MB`}`,
            ...metrics.photos.flatMap((p, i) => (p.error ? [`${i + 1}번 사진: ${p.error}`] : [])),
          ].join("\n")
        : "피부 보정: 아직 처리한 사진 없음"}
    </aside>
  );
}
