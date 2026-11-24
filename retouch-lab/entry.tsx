import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/noto-sans-kr";
import "./lab.css";
import { getFrame } from "@/config/frames";
import { FRAME_CARDS, V2_FRAMES, defaultOptions } from "@/config/frames/v2";
import { HAND_FONTS } from "@/config/hand-fonts";
import {
  RETOUCH_CONFIG,
  RETOUCH_LEVELS,
  RETOUCH_LEVEL_LABELS,
  type RetouchConfig,
  type RetouchLevelId,
} from "@/config/retouch";
import { createDomCanvas, get2d } from "@/lib/canvas";
import { loadFrameAssets, loadImageAsset } from "@/lib/compositor/assets";
import { composeFrame, formatDateLabel, formatStampLabel } from "@/lib/compositor/compose";
import { loadFrameFonts } from "@/lib/compositor/fonts";
import { coverCrop } from "@/lib/compositor/geometry";
import type { ComposeImage } from "@/lib/compositor/types";
import { createBrowserRetoucher } from "@/lib/retouch/browser";
import type { SkinRetoucher } from "@/lib/retouch/pipeline";
import { compareRetouch, type RetouchStats } from "@/lib/retouch/stats";
import type { BatchMetrics, PhotoMetrics, Rect } from "@/lib/retouch/types";

/**
 * The lab page: every sample at 원본 / 자연스럽게 / 뽀샤시 side by side, a strength slider per level,
 * zoom (to check the skin's grain), the mask, the photos in a frame, and how long this device
 * takes. It runs the booth's own module (lib/retouch) on the device that opened it: nothing here
 * is pre-rendered, so what you see on the iPad mini 4 is what that iPad computes.
 */

interface Sample {
  id: string;
  file: string;
  label: string;
  credit: string;
  license: string;
  pageUrl: string;
}

type Engine = RetouchConfig["engine"];
type Model = RetouchConfig["detection"]["model"];
type Size = 960 | 1600;
type Zoom = "fit" | "face" | 1 | 2 | 3;
type Level = Exclude<RetouchLevelId, "off">;

interface Shot {
  canvas: HTMLCanvasElement;
  metrics: PhotoMetrics | null;
  regions: Rect[];
  stats: RetouchStats | null;
}

const LEVELS: Level[] = ["natural", "glow"];
const ASPECT = 4 / 3;

function labConfig(engine: Engine, model: Model, tiles = true): RetouchConfig {
  return {
    ...RETOUCH_CONFIG,
    engine,
    detection: {
      ...RETOUCH_CONFIG.detection,
      model,
      tileGrid: tiles ? RETOUCH_CONFIG.detection.tileGrid : 0,
    },
  };
}

/** The sample as the booth would have shot it: centre-cropped to 4:3 at the capture size. */
async function loadShot(src: string, size: Size): Promise<HTMLCanvasElement> {
  const image = await loadImageAsset(src);
  const crop = coverCrop(image.width, image.height, ASPECT);
  const canvas = createDomCanvas(size, Math.round(size / ASPECT)) as HTMLCanvasElement;
  const ctx = get2d(canvas);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    image.source as CanvasImageSource,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return canvas;
}

function pixels(canvas: HTMLCanvasElement): Uint8ClampedArray {
  return get2d(canvas).getImageData(0, 0, canvas.width, canvas.height).data;
}

function probe() {
  const canvas = document.createElement("canvas");
  const gl1 = canvas.getContext("webgl") as WebGLRenderingContext | null;
  const gl2 = document.createElement("canvas").getContext("webgl2");
  // The smallest module that uses a SIMD instruction (v128.const; i8x16.popcnt): valid only with SIMD.
  const simd = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253,
    15, 253, 98, 11,
  ]);
  return {
    userAgent: navigator.userAgent,
    screen: `${window.innerWidth} × ${window.innerHeight} @${window.devicePixelRatio}x`,
    webgl1: !!gl1,
    webgl2: !!gl2,
    maxTexture: gl1 ? (gl1.getParameter(gl1.MAX_TEXTURE_SIZE) as number) : 0,
    wasm: typeof WebAssembly === "object",
    wasmSimd: typeof WebAssembly === "object" && WebAssembly.validate(simd),
    offscreenCanvas: typeof OffscreenCanvas !== "undefined",
    deviceMemory: (navigator as { deviceMemory?: number }).deviceMemory ?? null,
  };
}

const ms = (v: number) => `${Math.round(v)} ms`;
const mb = (v: number) => `${(v / 1048576).toFixed(1)} MB`;

/** One photo, drawn with the shared zoom. Hold it to see the original underneath. */
function Pane({
  title,
  shot,
  original,
  view,
  onPan,
  busy,
  testId,
}: {
  title: string;
  shot: Shot | null;
  original: HTMLCanvasElement | null;
  view: { scale: number; cx: number; cy: number };
  onPan: (dx: number, dy: number) => void;
  busy: boolean;
  testId: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [peek, setPeek] = useState(false);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const source = peek && original ? original : (shot?.canvas ?? null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !source) return;
    const box = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(box.width * dpr));
    canvas.height = Math.max(1, Math.round(box.height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // view.scale: photo pixels per CSS pixel is 1 / scale.
    const sw = box.width / view.scale;
    const sh = box.height / view.scale;
    const sx = view.cx * source.width - sw / 2;
    const sy = view.cy * source.height - sh / 2;
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = view.scale < 1;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  }, [source, view, shot]);

  return (
    <figure className="lab-pane" data-testid={testId}>
      <figcaption>
        {title}
        {peek && <em> 원본 보는 중</em>}
        {busy && <em> 계산 중…</em>}
      </figcaption>
      <canvas
        ref={ref}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, moved: false };
          if (original && shot && shot.canvas !== original) setPeek(true);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (!d.moved && Math.hypot(dx, dy) < 6) return;
          d.moved = true;
          setPeek(false);
          d.x = e.clientX;
          d.y = e.clientY;
          onPan(dx, dy);
        }}
        onPointerUp={() => {
          drag.current = null;
          setPeek(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setPeek(false);
        }}
      />
    </figure>
  );
}

function MetricsRow({ label, shot }: { label: string; shot: Shot | null }) {
  const m = shot?.metrics;
  const s = shot?.stats;
  if (!m) return null;
  return (
    <tr>
      <th>{label}</th>
      <td>{m.error ? `실패: ${m.error}` : `${m.facesRetouched} / ${m.facesFound}`}</td>
      <td>{ms(m.detectMs)}</td>
      <td>{ms(m.filterMs)}</td>
      <td>{m.engine ?? "-"}</td>
      <td>{s ? `${(s.fineRetention * 100).toFixed(0)} %` : "-"}</td>
      <td>{s ? `${(s.midReduction * 100).toFixed(0)} %` : "-"}</td>
      <td>{s ? s.lumaShift.toFixed(1) : "-"}</td>
      <td>{s ? `${(s.saturationRatio * 100).toFixed(0)} %` : "-"}</td>
      <td>{m.skipped.length ? m.skipped.join(", ") : "-"}</td>
    </tr>
  );
}

function Lab() {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sampleId, setSampleId] = useState<string | null>(null);
  const [size, setSize] = useState<Size>(960);
  const [engine, setEngine] = useState<Engine>("auto");
  const [model, setModel] = useState<Model>("landmarker");
  // The extra passes over tiles that find the small faces of a group photo.
  const [tiles, setTiles] = useState(true);
  const [zoom, setZoom] = useState<Zoom>("face");
  // How far the view has been dragged from where the zoom puts it (share of the photo).
  const [drag, setDrag] = useState({ dx: 0, dy: 0 });
  const [maskView, setMaskView] = useState(false);
  const [strength, setStrength] = useState<Record<Level, number>>({ natural: 1, glow: 1 });
  const [loaded, setLoaded] = useState<{ key: string; canvas: HTMLCanvasElement } | null>(null);
  const [done, setDone] = useState<{ key: string; shots: Record<Level, Shot | null> }>({
    key: "",
    shots: { natural: null, glow: null },
  });
  const [busy, setBusy] = useState<Record<Level, boolean>>({ natural: false, glow: false });
  const [errors, setErrors] = useState<string[]>([]);
  const [initMs, setInitMs] = useState<number | null>(null);
  const [batch, setBatch] = useState<{ level: Level; metrics: BatchMetrics } | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [frames, setFrames] = useState<{ label: string; url: string }[] | null>(null);
  const [frameBusy, setFrameBusy] = useState(false);
  const [frameCard, setFrameCard] = useState("film35");
  const [paneBox, setPaneBox] = useState({ width: 240, height: 320 });
  const info = useMemo(() => probe(), []);

  // One retoucher per engine/model choice: the model stays loaded, as on the booth.
  const retoucherRef = useRef<{ key: string; retoucher: SkinRetoucher } | null>(null);
  const retoucher = useCallback(() => {
    const key = `${engine}:${model}:${tiles}`;
    if (retoucherRef.current?.key !== key) {
      retoucherRef.current?.retoucher.dispose();
      retoucherRef.current = {
        key,
        retoucher: createBrowserRetoucher({
          config: labConfig(engine, model, tiles),
          onError: (code, detail) => setErrors((list) => [...list.slice(-5), `${code}: ${detail}`]),
        }),
      };
    }
    return retoucherRef.current.retoucher;
  }, [engine, model, tiles]);

  useEffect(() => {
    fetch("/retouch/samples/manifest.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`manifest ${r.status}`))))
      .then((list: Sample[]) => {
        setSamples(list);
        setSampleId((id) => id ?? list[0]?.id ?? null);
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, []);

  const sample = samples.find((s) => s.id === sampleId) ?? null;

  // The original at the chosen capture size. Anything loaded or computed for another sample or
  // size is simply not shown.
  const shotKey = sample ? `${sample.id}:${size}` : "";
  useEffect(() => {
    if (!sample) return;
    let live = true;
    const key = `${sample.id}:${size}`;
    loadShot(`/retouch/samples/${sample.file}`, size).then(
      (canvas) => live && setLoaded({ key, canvas }),
      (e: unknown) => live && setLoadError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [sample, size]);
  const original = loaded?.key === shotKey ? loaded.canvas : null;
  const shots = useMemo<Record<Level, Shot | null>>(
    () => (done.key === shotKey ? done.shots : { natural: null, glow: null }),
    [done, shotKey],
  );

  const run = useCallback(
    async (level: Level, base: HTMLCanvasElement, levelStrength: number, mask: boolean) => {
      const r = retoucher();
      const result = await r.retouchPhoto(
        { source: base, width: base.width, height: base.height },
        level,
        {
          level: RETOUCH_LEVELS[level],
          strength: levelStrength,
          view: mask ? "mask" : "result",
        },
      );
      if (r.lastInitMs > 0) setInitMs(r.lastInitMs);
      const canvas = result.image.source as HTMLCanvasElement;
      const stats =
        result.retouched && !mask
          ? compareRetouch(pixels(base), pixels(canvas), base.width, base.height, result.regions)
          : null;
      return { canvas, metrics: result.metrics, regions: result.regions, stats } satisfies Shot;
    },
    [retoucher],
  );

  // Each level again whenever its inputs change (one at a time: detection blocks the page).
  const jobRef = useRef(0);
  useEffect(() => {
    if (!original) return;
    const job = ++jobRef.current;
    const timer = setTimeout(async () => {
      for (const level of LEVELS) {
        if (jobRef.current !== job) return;
        setBusy((b) => ({ ...b, [level]: true }));
        try {
          const shot = await run(level, original, strength[level], maskView);
          if (jobRef.current !== job) return;
          setDone((d) => ({
            key: shotKey,
            shots: {
              ...(d.key === shotKey ? d.shots : { natural: null, glow: null }),
              [level]: shot,
            },
          }));
        } finally {
          setBusy((b) => ({ ...b, [level]: false }));
        }
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [original, shotKey, strength, maskView, run]);

  // Zoom: "얼굴" and the fixed scales start on the largest face the retoucher found.
  const faceRegion = shots.natural?.regions[0] ?? shots.glow?.regions[0] ?? null;
  const centre = useMemo(() => {
    const base =
      zoom !== "fit" && faceRegion && original
        ? {
            cx: (faceRegion.x + faceRegion.width / 2) / original.width,
            cy: (faceRegion.y + faceRegion.height / 2) / original.height,
          }
        : { cx: 0.5, cy: 0.5 };
    return {
      cx: Math.max(0, Math.min(1, base.cx + drag.dx)),
      cy: Math.max(0, Math.min(1, base.cy + drag.dy)),
    };
  }, [zoom, faceRegion, original, drag]);

  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const measure = () => {
      const pane = stageRef.current?.querySelector("canvas");
      if (!pane) return;
      const box = pane.getBoundingClientRect();
      if (box.width > 0) setPaneBox({ width: box.width, height: box.height });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [original]);

  const scale = useMemo(() => {
    if (!original) return 1;
    if (zoom === "fit")
      return Math.min(paneBox.width / original.width, paneBox.height / original.height);
    if (zoom === "face")
      return faceRegion
        ? Math.min(paneBox.width / faceRegion.width, paneBox.height / faceRegion.height)
        : Math.min(paneBox.width / original.width, paneBox.height / original.height);
    return zoom;
  }, [zoom, original, faceRegion, paneBox]);
  const view = { scale, ...centre };
  const pan = (dx: number, dy: number) => {
    if (!original) return;
    setDrag((d) => ({
      dx: d.dx - dx / scale / original.width,
      dy: d.dy - dy / scale / original.height,
    }));
  };

  const measureBatch = async (level: Level) => {
    setBatchBusy(true);
    try {
      const four = samples.slice(0, 4);
      const bases = await Promise.all(
        four.map((s) => loadShot(`/retouch/samples/${s.file}`, size)),
      );
      const { metrics, results } = await retoucher().retouchBatch(
        bases.map((c) => ({ source: c, width: c.width, height: c.height })),
        level,
        { level: RETOUCH_LEVELS[level], strength: strength[level] },
      );
      setBatch({ level, metrics });
      for (const r of results) if (r.retouched) (r.image.source as HTMLCanvasElement).width = 0;
      for (const c of bases) c.width = 0;
    } finally {
      setBatchBusy(false);
    }
  };

  const composeFrames = async () => {
    if (!sample) return;
    setFrameBusy(true);
    try {
      const card = FRAME_CARDS.find((c) => c.id === frameCard) ?? FRAME_CARDS[0]!;
      const frame = getFrame(card.frame(defaultOptions(card)).id);
      await loadFrameFonts(V2_FRAMES);
      const { assets } = await loadFrameAssets([frame]);
      // This sample first, then the ones after it in the list.
      const start = samples.findIndex((s) => s.id === sample.id);
      const picked = frame.slots.map((_, i) => samples[(start + i) % samples.length]!);
      const bases = await Promise.all(
        picked.map((s) => loadShot(`/retouch/samples/${s.file}`, size)),
      );
      const now = new Date();
      const render = (photos: ComposeImage[]) => {
        const canvas = composeFrame(frame, photos, {
          createCanvas: createDomCanvas,
          context: {
            dateLabel: formatDateLabel(now),
            stampLabel: formatStampLabel(now),
            handFont: HAND_FONTS[0]!.id,
            assets,
          },
          scale: size === 960 ? 1 : 2,
        }) as HTMLCanvasElement;
        const url = canvas.toDataURL("image/jpeg", 0.9);
        canvas.width = 0;
        return url;
      };
      const asImages = (list: HTMLCanvasElement[]): ComposeImage[] =>
        list.map((c) => ({ source: c, width: c.width, height: c.height }));
      const out = [{ label: RETOUCH_LEVEL_LABELS.off.ko, url: render(asImages(bases)) }];
      for (const level of LEVELS) {
        const { results } = await retoucher().retouchBatch(asImages(bases), level, {
          level: RETOUCH_LEVELS[level],
          strength: strength[level],
        });
        out.push({
          label: RETOUCH_LEVEL_LABELS[level].ko,
          url: render(results.map((r) => r.image as ComposeImage)),
        });
        for (const r of results) if (r.retouched) (r.image.source as HTMLCanvasElement).width = 0;
      }
      setFrames(out);
      for (const c of bases) c.width = 0;
    } finally {
      setFrameBusy(false);
    }
  };

  // For e2e/retouch.spec.ts: the same pipeline, driven from the test.
  useEffect(() => {
    (window as unknown as { __retouchLab?: unknown }).__retouchLab = {
      samples,
      async process(
        file: string,
        level: Level,
        opts: {
          size?: Size;
          engine?: Engine;
          model?: Model;
          strength?: number;
          tiles?: boolean;
        } = {},
      ) {
        const base = await loadShot(`/retouch/samples/${file}`, opts.size ?? 960);
        const r = createBrowserRetoucher({
          config: labConfig(opts.engine ?? "auto", opts.model ?? "landmarker", opts.tiles ?? true),
        });
        try {
          const result = await r.retouchPhoto(
            { source: base, width: base.width, height: base.height },
            level,
            { strength: opts.strength },
          );
          const after = result.image.source as HTMLCanvasElement;
          return {
            metrics: result.metrics,
            regions: result.regions,
            retouched: result.retouched,
            stats: compareRetouch(
              pixels(base),
              pixels(after),
              base.width,
              base.height,
              result.regions,
            ),
            image: after.toDataURL("image/png"),
          };
        } finally {
          r.dispose();
        }
      },
    };
  }, [samples]);

  if (loadError)
    return (
      <p className="lab-boot" data-testid="lab-error">
        샘플을 불러오지 못했어요: {loadError}
      </p>
    );

  return (
    <main className="lab" data-testid="retouch-lab">
      <header className="lab-head">
        <h1>피부 보정 비교</h1>
        <p>이 기기에서 지금 계산한 결과다. 사진을 누르고 있으면 원본이 보이고, 끌면 옮겨진다.</p>
      </header>

      <nav className="lab-samples" aria-label="샘플">
        {samples.map((s) => (
          <button
            key={s.id}
            className={s.id === sampleId ? "is-on" : ""}
            onClick={() => {
              setSampleId(s.id);
              setDrag({ dx: 0, dy: 0 });
            }}
            data-testid={`sample-${s.id}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- standalone page, no Next runtime */}
            <img src={`/retouch/samples/thumbs/${s.file}`} alt="" loading="lazy" />
            <span>{s.label}</span>
          </button>
        ))}
      </nav>

      <section className="lab-tools">
        <div className="lab-seg" role="group" aria-label="확대">
          {(
            [
              ["fit", "전체"],
              ["face", "얼굴"],
              [1, "100 %"],
              [2, "200 %"],
              [3, "300 %"],
            ] as [Zoom, string][]
          ).map(([z, label]) => (
            <button
              key={String(z)}
              className={zoom === z ? "is-on" : ""}
              onClick={() => {
                setZoom(z);
                setDrag({ dx: 0, dy: 0 });
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="lab-check">
          <input
            type="checkbox"
            checked={maskView}
            onChange={(e) => setMaskView(e.target.checked)}
            data-testid="mask-toggle"
          />
          마스크 보기
        </label>
        <div className="lab-seg" role="group" aria-label="촬영 크기">
          {([960, 1600] as Size[]).map((s) => (
            <button key={s} className={size === s ? "is-on" : ""} onClick={() => setSize(s)}>
              {s === 960 ? "960 (iPad mini 4)" : "1600"}
            </button>
          ))}
        </div>
      </section>

      <section className="lab-stage" ref={stageRef}>
        <Pane
          title="원본"
          shot={original ? { canvas: original, metrics: null, regions: [], stats: null } : null}
          original={null}
          view={view}
          onPan={pan}
          busy={false}
          testId="pane-original"
        />
        {LEVELS.map((level) => (
          <Pane
            key={level}
            title={RETOUCH_LEVEL_LABELS[level].ko}
            shot={shots[level]}
            original={original}
            view={view}
            onPan={pan}
            busy={busy[level]}
            testId={`pane-${level}`}
          />
        ))}
      </section>

      <section className="lab-sliders">
        {LEVELS.map((level) => (
          <label key={level}>
            <span>
              {RETOUCH_LEVEL_LABELS[level].ko} 강도 <b>{Math.round(strength[level] * 100)} %</b>
            </span>
            <input
              type="range"
              min={0}
              max={200}
              step={5}
              value={Math.round(strength[level] * 100)}
              onChange={(e) =>
                setStrength((s) => ({ ...s, [level]: Number(e.target.value) / 100 }))
              }
              data-testid={`strength-${level}`}
            />
          </label>
        ))}
      </section>

      {sample && (
        <p className="lab-credit">
          {sample.label} · {sample.credit} · {sample.license} ·{" "}
          <a href={sample.pageUrl} target="_blank" rel="noreferrer">
            출처
          </a>
        </p>
      )}

      <section className="lab-card">
        <h2>이 사진의 수치</h2>
        <div className="lab-scroll">
          <table data-testid="metrics">
            <thead>
              <tr>
                <th />
                <th>보정 / 찾은 얼굴</th>
                <th>검출</th>
                <th>보정</th>
                <th>엔진</th>
                <th>고운 결 유지</th>
                <th>얼룩 감소</th>
                <th>밝기 변화</th>
                <th>채도</th>
                <th>건너뜀</th>
              </tr>
            </thead>
            <tbody>
              {LEVELS.map((level) => (
                <MetricsRow
                  key={level}
                  label={RETOUCH_LEVEL_LABELS[level].ko}
                  shot={shots[level]}
                />
              ))}
            </tbody>
          </table>
        </div>
        <p className="lab-note">
          고운 결 유지: 보정된 픽셀에서 3 × 3 평균을 뺀 결의 세기(후 ÷ 전). 얼룩 감소: 얼굴 폭의 약
          1~6 % 크기 띠의 세기가 준 비율. 밝기 변화: 평균 밝기 차(0~255). 채도 100 % 미만이면 회색
          쪽으로 간 것.
          {initMs !== null && ` 모델을 올리는 데 ${ms(initMs)} 걸렸다.`}
        </p>
      </section>

      <section className="lab-card">
        <h2>네 장 연속 측정</h2>
        <p className="lab-note">
          앞의 샘플 네 장을 부스와 같은 순서로 처리한다. 목표는 합계{" "}
          {RETOUCH_CONFIG.budget.targetTotalMs / 1000}초 이내다(목표일 뿐이다. 아래 숫자가 이 기기의
          실제 값이다).
        </p>
        <div className="lab-row">
          {LEVELS.map((level) => (
            <button
              key={level}
              className="lab-btn"
              disabled={batchBusy || samples.length < 4}
              onClick={() => void measureBatch(level)}
              data-testid={`batch-${level}`}
            >
              {RETOUCH_LEVEL_LABELS[level].ko}로 측정
            </button>
          ))}
          <div className="lab-seg" role="group" aria-label="엔진">
            {(["auto", "webgl", "cpu"] as Engine[]).map((e) => (
              <button key={e} className={engine === e ? "is-on" : ""} onClick={() => setEngine(e)}>
                {e === "auto" ? "엔진 자동" : e === "webgl" ? "WebGL" : "CPU"}
              </button>
            ))}
          </div>
          <div className="lab-seg" role="group" aria-label="검출 모델">
            {(["landmarker", "detector"] as Model[]).map((m) => (
              <button key={m} className={model === m ? "is-on" : ""} onClick={() => setModel(m)}>
                {m === "landmarker" ? "랜드마크 478점" : "가벼운 6점"}
              </button>
            ))}
          </div>
          <label className="lab-check">
            <input type="checkbox" checked={tiles} onChange={(e) => setTiles(e.target.checked)} />
            작은 얼굴 추가 검출
          </label>
        </div>
        {batchBusy && <p className="lab-note">측정 중…</p>}
        {batch && (
          <div className="lab-scroll" data-testid="batch-result">
            <table>
              <thead>
                <tr>
                  <th>장</th>
                  <th>얼굴</th>
                  <th>검출</th>
                  <th>보정</th>
                  <th>합계</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {batch.metrics.photos.map((p, i) => (
                  <tr key={i}>
                    <th>{i + 1}</th>
                    <td>
                      {p.facesRetouched} / {p.facesFound}
                    </td>
                    <td>{ms(p.detectMs)}</td>
                    <td>{ms(p.filterMs)}</td>
                    <td>{ms(p.totalMs)}</td>
                    <td>{p.error ?? "됨"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="lab-total" data-testid="batch-total">
              {RETOUCH_LEVEL_LABELS[batch.level].ko} · 네 장 합계 <b>{ms(batch.metrics.totalMs)}</b>
              {batch.metrics.initMs > 0 && ` (모델 올리기 ${ms(batch.metrics.initMs)} 별도)`} ·
              메모리 추정 {mb(batch.metrics.peakBytes)}
              {batch.metrics.jsHeapBytes !== null && ` · JS 힙 ${mb(batch.metrics.jsHeapBytes)}`}
            </p>
          </div>
        )}
      </section>

      <section className="lab-card">
        <h2>틀에 얹어 보기</h2>
        <div className="lab-row">
          <div className="lab-seg" role="group" aria-label="틀">
            {FRAME_CARDS.map((c) => (
              <button
                key={c.id}
                className={frameCard === c.id ? "is-on" : ""}
                onClick={() => setFrameCard(c.id)}
              >
                {c.frame(defaultOptions(c)).label}
              </button>
            ))}
          </div>
          <button
            className="lab-btn"
            disabled={frameBusy || !sample}
            onClick={() => void composeFrames()}
            data-testid="compose-frames"
          >
            {frameBusy ? "만드는 중…" : "이 샘플부터 틀에 넣기"}
          </button>
        </div>
        {frames && (
          <div className="lab-frames" data-testid="frames">
            {frames.map((f) => (
              <figure key={f.label}>
                {/* eslint-disable-next-line @next/next/no-img-element -- data URL */}
                <img src={f.url} alt={f.label} />
                <figcaption>{f.label}</figcaption>
              </figure>
            ))}
          </div>
        )}
      </section>

      <section className="lab-card">
        <h2>이 기기</h2>
        <dl className="lab-info" data-testid="device-info">
          <dt>브라우저</dt>
          <dd>{info.userAgent}</dd>
          <dt>화면</dt>
          <dd>{info.screen}</dd>
          <dt>WebGL 1 / 2</dt>
          <dd>
            {info.webgl1 ? "됨" : "안 됨"} / {info.webgl2 ? "됨" : "안 됨"} (최대 텍스처{" "}
            {info.maxTexture})
          </dd>
          <dt>WebAssembly / SIMD</dt>
          <dd>
            {info.wasm ? "됨" : "안 됨"} / {info.wasmSimd ? "됨" : "없음"} (보정은 SIMD 없는 빌드로
            돈다)
          </dd>
          <dt>OffscreenCanvas</dt>
          <dd>{info.offscreenCanvas ? "있음" : "없음"}</dd>
          <dt>기기 메모리</dt>
          <dd>
            {info.deviceMemory
              ? `${info.deviceMemory} GB (브라우저 보고)`
              : "브라우저가 알려 주지 않음"}
          </dd>
        </dl>
        {errors.length > 0 && (
          <ul className="lab-errors" data-testid="lab-errors">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

const container = document.getElementById("retouch-lab");
if (container) createRoot(container).render(<Lab />);
