import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@/looks-sheet/ui-fonts";
import "@fontsource/caveat/latin-700.css";
import "@fontsource/nothing-you-could-do/latin-400.css";
import "@fontsource/reenie-beanie/latin-400.css";
import "@fontsource/permanent-marker/latin-400.css";
import "@fontsource/gloria-hallelujah/latin-400.css";
import "@fontsource/square-peg/latin-400.css";
import "@fontsource/rock-salt/latin-400.css";
import "@fontsource/shadows-into-light/latin-400.css";
import "@fontsource/covered-by-your-grace/latin-400.css";
import "@fontsource/give-you-glory/latin-400.css";
import "@fontsource/vt323/latin-400.css";
import "./sheet.css";
import { V2_FRAMES } from "@/config/frames/v2";
import { HAND_FONTS } from "@/config/hand-fonts";
import { LOOKS, getLook } from "@/config/looks";
import { createDomCanvas } from "@/lib/canvas";
import { loadFrameAssets, loadImageAsset } from "@/lib/compositor/assets";
import { composeFrame, formatDateLabel, formatStampLabel } from "@/lib/compositor/compose";
import { loadFrameFonts } from "@/lib/compositor/fonts";
import type { ComposeImage } from "@/lib/compositor/types";
import { createBoothLooks, type BoothLooks } from "@/lib/looks/booth";
import { CHART_HEIGHT, CHART_WIDTH, drawChart } from "@/lib/looks/chart";
import { lookForFrame } from "@/lib/looks/config";
import { SAMPLES, SYNTHETIC_NOTE } from "./samples";

/**
 * The look comparison sheet (/looks): every look side by side on one sample, each with its own
 * strength and its own before/after, and below it a frame with the look on its photos.
 *
 * It draws with the booth's own parts: `createBoothLooks` (the one WebGL shader and the .cube
 * files) and `composeFrame`. What is on this page is what the booth would save.
 */

const PICKS_KEY = "ftl.lookPicks";

/**
 * Where the page's files are. "" when the app serves it (absolute paths); "." when the same
 * bundle is published as a folder of files and everything is fetched relative to the page.
 */
const BASE = document.getElementById("looks-sheet")?.dataset.base ?? "";
const asset = (src: string) => BASE + src;
const fetchText = async (url: string) => {
  const response = await fetch(asset(url));
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
};

function readPicks(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(PICKS_KEY) ?? "[]") as unknown;
    return Array.isArray(stored)
      ? stored.filter((id) => typeof id === "string" && getLook(id))
      : [];
  } catch {
    return [];
  }
}

/** The drawn chart as a picture the compositor and the grader can take. */
function chartImage(): ComposeImage {
  const small = document.createElement("canvas");
  small.width = CHART_WIDTH;
  small.height = CHART_HEIGHT;
  const ctx = small.getContext("2d")!;
  const image = ctx.createImageData(CHART_WIDTH, CHART_HEIGHT);
  image.data.set(drawChart());
  ctx.putImageData(image, 0, 0);
  // Enlarged without smoothing, so every patch stays one flat colour.
  const big = document.createElement("canvas");
  big.width = CHART_WIDTH * 4;
  big.height = CHART_HEIGHT * 4;
  const bctx = big.getContext("2d")!;
  bctx.imageSmoothingEnabled = false;
  bctx.drawImage(small, 0, 0, big.width, big.height);
  return { source: big, width: big.width, height: big.height };
}

const TILE_ASPECT = 4 / 3;

/** One sample through one look, drawn into `canvas` at its own pixel size. */
function drawTile(
  canvas: HTMLCanvasElement,
  image: ComposeImage,
  looks: BoothLooks,
  lookId: string | null,
  strength: number,
  seed: number,
) {
  const width = canvas.width;
  const height = canvas.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  // Cover-crop to the tile, as the compositor crops a photo to its slot.
  const scratch = createDomCanvas(width, height) as HTMLCanvasElement;
  const sctx = scratch.getContext("2d")!;
  sctx.imageSmoothingQuality = "high";
  const sourceAspect = image.width / image.height;
  const cropW = sourceAspect > TILE_ASPECT ? image.height * TILE_ASPECT : image.width;
  const cropH = sourceAspect > TILE_ASPECT ? image.height : image.width / TILE_ASPECT;
  sctx.drawImage(
    image.source,
    (image.width - cropW) / 2,
    (image.height - cropH) / 2,
    cropW,
    cropH,
    0,
    0,
    width,
    height,
  );
  const grader =
    lookId && strength > 0 ? looks.graderFor("sheet", seed, { lookId, strength }) : undefined;
  const graded = grader ? grader(scratch, width, height, 0) : null;
  ctx.drawImage(graded ?? scratch, 0, 0, width, height);
  scratch.width = scratch.height = 0;
}

function Tile({
  image,
  looks,
  lookId,
  strength,
  seed,
  label,
  layout,
}: {
  image: ComposeImage | null;
  looks: BoothLooks;
  lookId: string | null;
  strength: number;
  seed: number;
  label: string;
  /** Changes when the tiles change size (view switch, rotation), so they are drawn again. */
  layout: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !image) return;
    const cssWidth = canvas.clientWidth || 360;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.round(cssWidth * ratio);
    const height = Math.round(width / TILE_ASPECT);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    drawTile(canvas, image, looks, lookId, strength, seed);
  }, [image, looks, lookId, strength, seed, layout]);
  return <canvas ref={ref} className="tile-canvas" role="img" aria-label={label} />;
}

function Sheet() {
  const [looks] = useState(() => {
    const created = createBoothLooks({ fetchText });
    // A handle for e2e/looks.spec.ts, which holds the GPU result to the reference arithmetic.
    (window as unknown as { __studioLooks?: BoothLooks }).__studioLooks = created;
    return created;
  });
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sampleId, setSampleId] = useState(SAMPLES[0]!.id);
  // The chart is drawn, not loaded: it is there from the first render.
  const [images, setImages] = useState<Record<string, ComposeImage>>(() => ({
    chart: chartImage(),
  }));
  const [strengths, setStrengths] = useState<Record<string, number>>(() =>
    Object.fromEntries(LOOKS.map((look) => [look.id, Math.round(look.strength * 100)])),
  );
  const [showOriginal, setShowOriginal] = useState<Record<string, boolean>>({});
  const [picks, setPicks] = useState<string[]>(readPicks);
  // "한눈에": nine small prints on one screen. "세기 조절": two across, with the controls.
  const [view, setView] = useState<"glance" | "adjust">("glance");
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const layout = `${view}:${windowWidth}`;

  // Looks and samples first; the frame section loads its own art when it is opened.
  useEffect(() => {
    let cancelled = false;
    void looks.preloadLooks(LOOKS.map((look) => look.id)).then(() => {
      if (!cancelled) setReady(true);
    });
    for (const sample of SAMPLES) {
      if (sample.src === "chart") continue;
      void loadImageAsset(asset(sample.src)).then(
        (image) => {
          if (!cancelled) setImages((all) => ({ ...all, [sample.id]: image }));
        },
        () => console.error(`[looks] Sample ${sample.src} did not load`),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [looks]);

  // WebGL trouble is reported by the grader itself; show it on the page as well.
  useEffect(() => {
    const timer = setInterval(() => setProblem(looks.problem()), 1000);
    return () => clearInterval(timer);
  }, [looks]);

  const sample = SAMPLES.find((s) => s.id === sampleId) ?? SAMPLES[0]!;
  const image = images[sample.id] ?? null;
  const seed = SAMPLES.indexOf(sample) + 1;

  const togglePick = useCallback((id: string) => {
    setPicks((current) => {
      const next = current.includes(id) ? current.filter((p) => p !== id) : [...current, id];
      try {
        localStorage.setItem(PICKS_KEY, JSON.stringify(next));
      } catch {
        // Private mode: the marks last until the page is closed.
      }
      return next;
    });
  }, []);

  return (
    <main className="sheet">
      <header className="sheet-head">
        <p className="sheet-brand" aria-label="STUDIO SHALOM">
          STUDIO SHALOM
        </p>
        <h1>룩 비교 시트</h1>
        <p className="sheet-lede">
          필름은 한 종류, 현상만 다릅니다. 여덟 가지 현상을 같은 사진에 올려 놓았습니다. 「세기
          조절」에서 룩마다 세기를 바꾸고, 「원본」을 누르면 찍힌 그대로로 바뀝니다.
        </p>
      </header>

      <nav className="sample-bar" aria-label="샘플 사진">
        {SAMPLES.map((s) => (
          <button
            key={s.id}
            type="button"
            className="sample-chip"
            aria-pressed={s.id === sample.id}
            onClick={() => setSampleId(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div className="sample-row">
        <p className="sample-note" data-testid="sample-note">
          {sample.tests}
        </p>
        <div className="view-switch" role="group" aria-label="보는 방식">
          <button
            type="button"
            className="chip"
            aria-pressed={view === "glance"}
            onClick={() => setView("glance")}
          >
            한눈에
          </button>
          <button
            type="button"
            className="chip"
            aria-pressed={view === "adjust"}
            onClick={() => setView("adjust")}
          >
            세기 조절
          </button>
        </div>
      </div>

      {problem && (
        <p className="sheet-alert" role="alert" data-testid="looks-problem">
          이 브라우저에서 룩을 그리지 못했습니다 ({problem}). 사진은 원본으로 보입니다.
        </p>
      )}

      <section
        className="tiles"
        aria-label="룩 목록"
        data-ready={ready && !!image}
        data-view={view}
      >
        <article className="tile tile-original">
          <Tile
            image={image}
            looks={looks}
            lookId={null}
            strength={0}
            seed={seed}
            label="원본"
            layout={layout}
          />
          <div className="tile-meta">
            <h2>
              Original <span lang="ko">원본</span>
            </h2>
            <p>카메라가 찍은 그대로. 지금 대부분의 틀이 이 상태로 나갑니다.</p>
          </div>
        </article>

        {LOOKS.map((look) => {
          const value = strengths[look.id] ?? 100;
          const original = !!showOriginal[look.id];
          const picked = picks.includes(look.id);
          return (
            <article key={look.id} className="tile" data-look={look.id} data-picked={picked}>
              <Tile
                image={ready ? image : null}
                looks={looks}
                lookId={look.id}
                strength={original ? 0 : value / 100}
                seed={seed}
                label={`${look.nameKo} 룩을 입힌 샘플`}
                layout={layout}
              />
              <div className="tile-meta">
                <h2>
                  {look.name} <span lang="ko">{look.nameKo}</span>
                </h2>
                <p>{look.summary}</p>
                <div className="tile-controls">
                  <label className="strength">
                    <span>세기</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={value}
                      aria-label={`${look.nameKo} 세기`}
                      onChange={(event) =>
                        setStrengths((all) => ({ ...all, [look.id]: Number(event.target.value) }))
                      }
                    />
                    <output>{value}%</output>
                  </label>
                  <button
                    type="button"
                    className="chip"
                    aria-pressed={original}
                    aria-label={`${look.nameKo}: 원본 보기`}
                    onClick={() => setShowOriginal((all) => ({ ...all, [look.id]: !original }))}
                  >
                    원본
                  </button>
                  <button
                    type="button"
                    className="chip chip-pick"
                    aria-pressed={picked}
                    aria-label={`${look.nameKo} 고르기`}
                    onClick={() => togglePick(look.id)}
                  >
                    {picked ? "골랐음" : "고르기"}
                  </button>
                </div>
                <details>
                  <summary>왜 이렇게 만들었나</summary>
                  <p>{look.why}</p>
                </details>
              </div>
            </article>
          );
        })}
      </section>

      <p className="picks" data-testid="picks">
        {picks.length
          ? `고른 룩: ${picks.map((id) => getLook(id)?.nameKo).join(", ")}`
          : "마음에 드는 룩에 「고르기」를 눌러 두면 여기에 모입니다."}
      </p>

      <FrameSection looks={looks} ready={ready} images={images} sampleId={sample.id} />

      <footer className="sheet-foot">
        <h2>샘플 출처</h2>
        <p>{SYNTHETIC_NOTE}</p>
        <p>
          색 차트는 사진이 아니라 계산으로 그린 그림입니다. 틀 그림과 글꼴은 부스가 쓰는 것과
          같습니다.
        </p>
        <p>
          이 페이지는 부스와 같은 셰이더, 같은 LUT 파일(<code>/looks/*.cube</code>)로 그립니다. 손님
          사진은 쓰지 않으며 어디로도 보내지 않습니다.
        </p>
      </footer>
    </main>
  );
}

function FrameSection({
  looks,
  ready,
  images,
  sampleId,
}: {
  looks: BoothLooks;
  ready: boolean;
  images: Record<string, ComposeImage>;
  sampleId: string;
}) {
  const [frameId, setFrameId] = useState("film4-cream");
  const mapped = lookForFrame(frameId);
  const [lookChoice, setLookChoice] = useState<{ frameId: string; lookId: string } | null>(null);
  const lookId = lookChoice?.frameId === frameId ? lookChoice.lookId : (mapped?.look.id ?? "paper");
  const [strength, setStrength] = useState<{ key: string; value: number } | null>(null);
  const strengthKey = `${frameId}:${lookId}`;
  const defaultStrength = Math.round(
    (mapped && mapped.look.id === lookId ? mapped.strength : 1) * 100,
  );
  const strengthValue = strength?.key === strengthKey ? strength.value : defaultStrength;
  const [assets, setAssets] = useState<Map<string, ComposeImage> | null>(null);
  const beforeRef = useRef<HTMLCanvasElement>(null);
  const afterRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      loadFrameFonts(V2_FRAMES),
      loadFrameAssets(V2_FRAMES, (src) => loadImageAsset(asset(src))),
    ]).then(([, loaded]) => {
      if (!cancelled) setAssets(loaded.assets);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The chosen sample first, then the other photos, so a strip is not one face four times.
  const photos = useMemo(() => {
    const order = SAMPLES.filter((s) => s.src !== "chart" || s.id === sampleId);
    const start = Math.max(
      0,
      order.findIndex((s) => s.id === sampleId),
    );
    return [...order.slice(start), ...order.slice(0, start)]
      .map((s) => images[s.id])
      .filter((image): image is ComposeImage => !!image);
  }, [images, sampleId]);

  useEffect(() => {
    const frame = V2_FRAMES.find((f) => f.id === frameId);
    if (!frame || !assets || !ready || photos.length === 0) return;
    const chosen = frame.slots.map((_, i) => photos[i % photos.length]!);
    const now = new Date();
    const context = {
      dateLabel: formatDateLabel(now),
      stampLabel: formatStampLabel(now),
      handFont: HAND_FONTS[0]!.id,
      assets,
    };
    // Each strip is shown about 330 px wide, whatever the frame's own size.
    const scale = (Math.min(2, window.devicePixelRatio || 1) * 330) / frame.outputWidth;
    const draw = (target: HTMLCanvasElement | null, withLook: boolean) => {
      if (!target) return;
      const composed = composeFrame(frame, chosen, {
        createCanvas: createDomCanvas,
        context,
        scale,
        grade: withLook
          ? looks.graderFor(frame.id, 7, { lookId, strength: strengthValue / 100 })
          : undefined,
      }) as HTMLCanvasElement;
      target.width = composed.width;
      target.height = composed.height;
      target.getContext("2d")?.drawImage(composed, 0, 0);
      composed.width = composed.height = 0;
    };
    draw(beforeRef.current, false);
    draw(afterRef.current, true);
  }, [frameId, lookId, strengthValue, assets, ready, photos, looks]);

  const frame = V2_FRAMES.find((f) => f.id === frameId);
  const portrait = !frame || frame.outputHeight >= frame.outputWidth;

  return (
    <section className="frames" aria-label="틀에 얹어 보기">
      <h2>틀에 얹어 보기</h2>
      <p className="sheet-lede">
        왼쪽은 지금 부스가 내보내는 결과, 오른쪽은 같은 틀에 새 룩을 입힌 결과입니다.
      </p>
      <div className="frame-controls">
        <label>
          <span>틀</span>
          <select
            value={frameId}
            aria-label="틀 고르기"
            onChange={(event) => setFrameId(event.target.value)}
          >
            {V2_FRAMES.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>룩</span>
          <select
            value={lookId}
            aria-label="룩 고르기"
            onChange={(event) => setLookChoice({ frameId, lookId: event.target.value })}
          >
            {LOOKS.map((look) => (
              <option key={look.id} value={look.id}>
                {look.name} · {look.nameKo}
                {mapped?.look.id === look.id ? " (이 틀의 기본)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="strength">
          <span>세기</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={strengthValue}
            aria-label="틀에 얹은 룩의 세기"
            onChange={(event) =>
              setStrength({ key: strengthKey, value: Number(event.target.value) })
            }
          />
          <output>{strengthValue}%</output>
        </label>
      </div>
      <div className="frame-pair" data-shape={portrait ? "portrait" : "landscape"}>
        <figure>
          <canvas ref={beforeRef} data-testid="frame-before" role="img" aria-label="지금 결과" />
          <figcaption>지금</figcaption>
        </figure>
        <figure>
          <canvas ref={afterRef} data-testid="frame-after" role="img" aria-label="새 룩 결과" />
          <figcaption>
            새 룩 · {getLook(lookId)?.nameKo} {strengthValue}%
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

const container = document.getElementById("looks-sheet");
if (container) createRoot(container).render(<Sheet />);
