import "./lab.css";
import { CAMERA_ENGINE, CAMERA_PROFILES } from "@/config/camera-engine";
import { KIOSK_CONFIG } from "@/config/kiosk";
import { grabFrame } from "@/lib/camera/capture";
import { createDomCanvas, get2d } from "@/lib/canvas";
import { CameraEngine } from "@/lib/camera-engine/engine";
import { DEG, apply, chain, rotX, rotZ, type Mat3 } from "@/lib/camera-engine/mat3";
import { intrinsicsFor } from "@/lib/camera-engine/model";
import {
  cameraEngineFromAddress,
  defaultCameraEngine,
  type CameraEngineSettings,
} from "@/lib/camera-engine/settings";
import { engineStatusLine, engineStatusRows } from "@/lib/camera-engine/status";
import { warpPixels } from "@/lib/camera-engine/warp-cpu";
import { GlWarper, type GlCanvas } from "@/lib/camera-engine/warp-gl";

/**
 * /camera-lab: the camera engine on the tablet that opened the page. Plain DOM, no framework,
 * compiled for Safari 15. Nothing is stored and nothing is sent: the camera's picture and the
 * sensor readings stay in this page.
 *
 * `?source=chart&chartTilt=<roll>,<pitch>` replaces the camera with a drawn wall of plumb and
 * level lines as a camera with that tilt would see it (for machines without a camera, and for
 * the automated check). `?engine=` and `?tilt=` work as on the booth.
 */

const params = new URLSearchParams(window.location.search);
const ASPECT = KIOSK_CONFIG.captureAspect;
const root = document.getElementById("camera-lab")!;

root.innerHTML = `
<header class="lab-head">
  <h1>카메라 자동 보정 점검</h1>
  <p>이 태블릿의 카메라와 기울기 센서로 보정을 직접 확인하는 페이지예요. 사진과 센서 값은 이 화면 밖으로 나가지 않아요.</p>
</header>
<section class="lab-controls" data-testid="lab-controls">
  <div class="lab-row" role="group" aria-label="보정 방식">
    <button type="button" data-mode="off">끄기</button>
    <button type="button" data-mode="auto">자동</button>
    <button type="button" data-mode="manual">수동</button>
  </div>
  <label class="lab-field">좌우 보정값 <output id="roll-out"></output>
    <input id="roll" type="range" min="-${CAMERA_ENGINE.limits.rollOffsetDeg}" max="${CAMERA_ENGINE.limits.rollOffsetDeg}" step="0.5" data-testid="lab-roll"></label>
  <label class="lab-field">앞뒤 보정값 <output id="pitch-out"></output>
    <input id="pitch" type="range" min="-${CAMERA_ENGINE.limits.pitchOffsetDeg}" max="${CAMERA_ENGINE.limits.pitchOffsetDeg}" step="0.5" data-testid="lab-pitch"></label>
  <div class="lab-row">
    <label><input id="level" type="checkbox"> 좌우 기울기 보정</label>
    <label><input id="perspective" type="checkbox"> 앞뒤 기울기 보정</label>
    <label><input id="guard" type="checkbox"> 사람 왜곡 방지</label>
  </div>
  <label class="lab-field">카메라 화각(°, 비우면 ${CAMERA_PROFILES[0]!.fovLongDeg}° 추정값)
    <input id="fov" type="number" min="${CAMERA_ENGINE.limits.fovMinDeg}" max="${CAMERA_ENGINE.limits.fovMaxDeg}" step="1" inputmode="numeric" data-testid="lab-fov"></label>
  <div class="lab-row">
    <button type="button" id="start" class="lab-primary" data-testid="lab-start">카메라 켜기 · 센서 허용</button>
    <button type="button" id="shoot" data-testid="lab-shoot" disabled>테스트 촬영</button>
    <button type="button" id="selftest" data-testid="lab-selftest">그리기 자가 점검</button>
  </div>
</section>
<section class="lab-stage">
  <figure>
    <figcaption>미리보기 (보정 적용)</figcaption>
    <div class="lab-box" id="box" data-testid="lab-preview-box"><video id="video" muted playsinline autoplay data-testid="lab-preview"></video><div class="lab-grid"></div></div>
  </figure>
  <figure>
    <figcaption>촬영: 보정 전</figcaption>
    <div class="lab-box"><canvas id="before" data-testid="lab-before"></canvas><div class="lab-grid"></div></div>
  </figure>
  <figure>
    <figcaption>촬영: 보정 후 <span id="timing" data-testid="lab-timing"></span></figcaption>
    <div class="lab-box"><canvas id="after" data-testid="lab-after"></canvas><div class="lab-grid"></div></div>
  </figure>
</section>
<section class="lab-status" data-testid="lab-status">
  <h2>상태</h2>
  <p id="line" data-testid="lab-line"></p>
  <dl id="rows"></dl>
  <p class="lab-note">각도는 태블릿 센서로 추정한 값이에요. 사진에서 잰 값이 아니에요.</p>
</section>
<section class="lab-status">
  <h2>그리기 자가 점검</h2>
  <p id="selftest-out" data-testid="lab-selftest-out">아직 안 했어요. WebGL로 그린 그림을 기준 계산과 한 픽셀씩 비교해요.</p>
</section>
<section class="lab-status">
  <h2>확인 순서</h2>
  <ol>
    <li>「카메라 켜기 · 센서 허용」을 누르고, 묻는 창에서 모두 허용해요.</li>
    <li>「자동」에서 태블릿 윗부분을 오른쪽으로 기울여요. 좌우 기울기가 <b>+</b>로 커지고, 미리보기 속 세로선이 다시 똑바로 서면 정상이에요.</li>
    <li>태블릿을 뒤로 젖혀요. 앞뒤 기울기가 <b>+</b>로 커지면 정상이에요.</li>
    <li>반대로 움직이거나 더 기울어 보이면 「끄기」로 두고 알려 주세요. 부호가 이 기기에서 반대라는 뜻이에요.</li>
    <li>「테스트 촬영」을 눌러 보정 전·후와 걸린 시간을 확인해요.</li>
  </ol>
</section>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const box = $<HTMLDivElement>("box");
const before = $<HTMLCanvasElement>("before");
const after = $<HTMLCanvasElement>("after");

// ── The engine, set from the controls ───────────────────────────────────────────────────────
const engine = new CameraEngine();
let settings: CameraEngineSettings = cameraEngineFromAddress(window.location.search, {
  ...defaultCameraEngine(),
  mode: "auto",
});
const inputs = {
  roll: $<HTMLInputElement>("roll"),
  pitch: $<HTMLInputElement>("pitch"),
  level: $<HTMLInputElement>("level"),
  perspective: $<HTMLInputElement>("perspective"),
  guard: $<HTMLInputElement>("guard"),
  fov: $<HTMLInputElement>("fov"),
};
inputs.roll.value = String(settings.rollOffset);
inputs.pitch.value = String(settings.pitchOffset);
inputs.level.checked = settings.level;
inputs.perspective.checked = settings.perspective;
inputs.guard.checked = settings.portraitGuard;

function readControls() {
  const fov = Number(inputs.fov.value);
  settings = {
    ...settings,
    rollOffset: Number(inputs.roll.value),
    pitchOffset: Number(inputs.pitch.value),
    level: inputs.level.checked,
    perspective: inputs.perspective.checked,
    portraitGuard: inputs.guard.checked,
    fov:
      inputs.fov.value !== "" &&
      fov >= CAMERA_ENGINE.limits.fovMinDeg &&
      fov <= CAMERA_ENGINE.limits.fovMaxDeg
        ? fov
        : null,
  };
  $("roll-out").textContent = `${settings.rollOffset.toFixed(1)}°`;
  $("pitch-out").textContent = `${settings.pitchOffset.toFixed(1)}°`;
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-mode]"))
    button.setAttribute("aria-pressed", String(button.dataset.mode === settings.mode));
  engine.configure(settings);
}
for (const input of Object.values(inputs)) input.addEventListener("input", readControls);
for (const button of root.querySelectorAll<HTMLButtonElement>("[data-mode]"))
  button.addEventListener("click", () => {
    settings = { ...settings, mode: button.dataset.mode as CameraEngineSettings["mode"] };
    readControls();
  });

// ── The source: the camera, or the drawn wall ───────────────────────────────────────────────
interface Source {
  element: CanvasImageSource;
  width: () => number;
  height: () => number;
}
let source: Source | null = null;

/** A wall of plumb and level lines and one round face, as a camera with this tilt sees it. */
function drawWall(canvas: HTMLCanvasElement, roll: number, pitch: number, fov: number) {
  const { width: w, height: h } = canvas;
  const ctx = get2d(canvas);
  const k = intrinsicsFor(w, h, fov);
  // A point of the level view (tangents right and down) → this camera's pixel.
  const toCamera = chain(rotZ(roll * DEG), rotX(-pitch * DEG));
  const pixel = (x: number, y: number) => {
    const ray = apply(toCamera, [x, y, 1]);
    return [k.cx + (k.f * ray[0]) / ray[2], k.cy + (k.f * ray[1]) / ray[2]] as const;
  };
  ctx.fillStyle = "#1d2a3a";
  ctx.fillRect(0, 0, w, h);
  ctx.lineWidth = Math.max(2, w / 320);
  for (let i = -12; i <= 12; i++) {
    const t = i * 0.125;
    // Plumb lines light, level lines warm, the two through the middle brightest.
    for (const [from, to, colour] of [
      [pixel(t, -2), pixel(t, 2), i === 0 ? "#ffffff" : "#9fb4cc"],
      [pixel(-2, t), pixel(2, t), i === 0 ? "#ffd27a" : "#8a6f3c"],
    ] as const) {
      ctx.strokeStyle = colour;
      ctx.beginPath();
      ctx.moveTo(from[0], from[1]);
      ctx.lineTo(to[0], to[1]);
      ctx.stroke();
    }
  }
  // A round face in the middle of the picture, as the camera saw it.
  ctx.fillStyle = "#e9b48f";
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, h * 0.11, 0, Math.PI * 2);
  ctx.fill();
}

async function startSource() {
  if (params.get("source") === "chart") {
    const tilt = (params.get("chartTilt") ?? "6,12").split(",").map(Number);
    const size = (params.get("chartSize") ?? "1280x720").split("x").map(Number);
    const canvas = document.createElement("canvas");
    canvas.width = size[0] || 1280;
    canvas.height = size[1] || 720;
    drawWall(canvas, tilt[0] || 0, tilt[1] || 0, CAMERA_PROFILES[0]!.fovLongDeg);
    source = { element: canvas, width: () => canvas.width, height: () => canvas.height };
    engine.setCamera({ kind: "mock", facing: "user" });
    if (typeof canvas.captureStream === "function") {
      video.srcObject = canvas.captureStream(5);
      // A still canvas sends a frame only when it is drawn on.
      setInterval(() => get2d(canvas).fillRect(0, 0, 0, 0), 200);
    }
  } else {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    video.srcObject = stream;
    const facing = stream.getVideoTracks()[0]?.getSettings?.().facingMode;
    engine.setCamera({
      kind: "browser",
      facing: facing === "environment" ? "environment" : "user",
    });
    source = { element: video, width: () => video.videoWidth, height: () => video.videoHeight };
  }
  await video.play().catch(() => undefined);
  $<HTMLButtonElement>("shoot").disabled = false;
  root.dataset.source = "ready";
}

$("start").addEventListener("click", () => {
  // Inside this touch: the only place iOS lets a page ask for the motion sensors.
  engine.requestPermission();
  startSource().catch((err: unknown) => {
    $("line").textContent =
      `카메라를 켤 수 없어요: ${err instanceof Error ? err.message : String(err)}`;
  });
});

// ── Preview: the same CSS matrix the booth gives its <video> ────────────────────────────────
function placePreview() {
  const layout = engine.preview(
    video.videoWidth,
    video.videoHeight,
    box.clientWidth,
    box.clientHeight,
    ASPECT,
    KIOSK_CONFIG.mirror,
  );
  const s = video.style;
  if (!layout) {
    s.position = s.left = s.top = s.width = s.height = s.maxWidth = s.objectFit = "";
    s.transformOrigin = "";
    s.transform = KIOSK_CONFIG.mirror ? "scaleX(-1)" : "";
    delete video.dataset.engine;
    return;
  }
  s.position = "absolute";
  s.left = `${layout.left}px`;
  s.top = `${layout.top}px`;
  s.width = `${layout.width}px`;
  s.height = `${layout.height}px`;
  s.maxWidth = "none";
  s.objectFit = "fill";
  s.transformOrigin = "0 0";
  s.transform = layout.transform;
  video.dataset.engine = "on";
}
engine.subscribe(placePreview);
video.addEventListener("loadedmetadata", placePreview);
video.addEventListener("resize", placePreview);
window.addEventListener("resize", placePreview);

// ── Status, once a second ───────────────────────────────────────────────────────────────────
function showStatus() {
  if (!engine.active()) {
    $("line").textContent = "꺼짐";
    $("line").dataset.state = "off";
    $("rows").innerHTML = "";
    return;
  }
  const status = engine.status();
  const line = $("line");
  line.textContent = engineStatusLine(status);
  line.dataset.state = status.state;
  line.dataset.backend = status.backend;
  line.dataset.appliedRoll = String(status.appliedRoll);
  line.dataset.appliedPitch = String(status.appliedPitch);
  line.dataset.zoom = String(status.zoom);
  $("rows").innerHTML = engineStatusRows(status)
    .map((row) => `<div><dt>${row.label}</dt><dd>${row.value}</dd></div>`)
    .join("");
}
engine.subscribe(showStatus);
setInterval(showStatus, 1000);

// ── A test shot: the booth's own capture, with and without the correction ───────────────────
const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!;

$("shoot").addEventListener("click", () => {
  if (!source || !source.width()) return;
  const options = { aspect: ASPECT, mirror: KIOSK_CONFIG.mirror, maxWidth: 960 };
  const show = (target: HTMLCanvasElement, picture: HTMLCanvasElement) => {
    target.width = picture.width;
    target.height = picture.height;
    get2d(target).drawImage(picture, 0, 0);
    picture.width = picture.height = 0;
  };
  const plain = grabFrame(
    source.element,
    source.width(),
    source.height(),
    options,
    createDomCanvas,
  );
  show(before, plain.canvas as HTMLCanvasElement);
  // Several shots, as a session takes several: the first one also builds the WebGL program.
  const times: number[] = [];
  let corrected = false;
  for (let i = 0; i < 6; i++) {
    let used = false;
    const started = performance.now();
    const frame = grabFrame(
      source.element,
      source.width(),
      source.height(),
      {
        ...options,
        correct: (input) => {
          const picture = engine.correct(input);
          used = picture !== null;
          return picture;
        },
      },
      createDomCanvas,
    );
    times.push(performance.now() - started);
    corrected = used;
    if (i === 5) show(after, frame.canvas as HTMLCanvasElement);
    else (frame.canvas as HTMLCanvasElement).width = 0;
  }
  const timing = $("timing");
  timing.textContent = corrected
    ? `· 첫 장 ${times[0]!.toFixed(0)}ms, 이후 가운데값 ${median(times.slice(1)).toFixed(0)}ms`
    : "· 보정할 것이 없어서 그대로 찍었어요";
  timing.dataset.corrected = String(corrected);
  timing.dataset.firstMs = times[0]!.toFixed(1);
  timing.dataset.medianMs = median(times.slice(1)).toFixed(1);
  showStatus();
});

// ── Self-test: the WebGL renderer against the reference arithmetic, pixel by pixel ──────────
$("selftest").addEventListener("click", () => {
  const out = $("selftest-out");
  const [sw, sh, ow, oh] = [640, 360, 480, 360];
  const chart = document.createElement("canvas");
  chart.width = sw;
  chart.height = sh;
  const ctx = get2d(chart);
  for (let y = 0; y < sh; y += 20)
    for (let x = 0; x < sw; x += 20) {
      ctx.fillStyle = ((x + y) / 20) % 2 ? "#e8e0d0" : "#30506a";
      ctx.fillRect(x, y, 20, 20);
    }
  ctx.fillStyle = "#c0392b";
  ctx.beginPath();
  ctx.arc(sw / 2, sh / 2, 60, 0, Math.PI * 2);
  ctx.fill();
  // A homography with a turn, a perspective part and the mirror, like a real plan's.
  const map: Mat3 = [-1.02, 0.11, 566, 0.09, 1.0, -22, 0.00008, 0.00021, 1];
  try {
    const cpuStart = performance.now();
    const reference = warpPixels(
      { data: ctx.getImageData(0, 0, sw, sh).data, width: sw, height: sh },
      ow,
      oh,
      map,
    );
    const cpuMs = performance.now() - cpuStart;
    const warper = new GlWarper(document.createElement("canvas") as unknown as GlCanvas);
    warper.render(chart, sw, sh, ow, oh, map);
    const glStart = performance.now();
    const drawn = warper.render(chart, sw, sh, ow, oh, map) as unknown as HTMLCanvasElement;
    const copy = document.createElement("canvas");
    copy.width = ow;
    copy.height = oh;
    get2d(copy).drawImage(drawn, 0, 0);
    const pixels = get2d(copy).getImageData(0, 0, ow, oh).data;
    const glMs = performance.now() - glStart;
    warper.dispose();
    let max = 0;
    let sum = 0;
    let over = 0;
    for (let i = 0; i < pixels.length; i++) {
      if (i % 4 === 3) continue;
      const d = Math.abs(pixels[i]! - reference[i]!);
      max = Math.max(max, d);
      sum += d;
      if (d > 8) over++;
    }
    const mean = sum / ((pixels.length / 4) * 3);
    const share = over / ((pixels.length / 4) * 3);
    out.textContent = `WebGL 정상 · 기준과 평균 ${mean.toFixed(2)}단계 차이, 8단계 넘게 다른 값 ${(share * 100).toFixed(2)}% · WebGL ${glMs.toFixed(1)}ms, 기준 계산 ${cpuMs.toFixed(0)}ms (${ow}×${oh})`;
    Object.assign(out.dataset, {
      result: mean < 1 && share < 0.01 ? "pass" : "differs",
      mean: mean.toFixed(3),
      max: String(max),
      share: share.toFixed(5),
      glMs: glMs.toFixed(2),
      cpuMs: cpuMs.toFixed(1),
    });
  } catch (err) {
    out.textContent = `WebGL을 쓸 수 없어요 (${err instanceof Error ? err.message : String(err)}). 이 기기에서는 좌우 기울기만 보정돼요.`;
    out.dataset.result = "no-webgl";
  }
});

readControls();
showStatus();
if (params.get("source") === "chart") void startSource();
