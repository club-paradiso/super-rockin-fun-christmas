/**
 * Booth speed log (「속도 기록」, 2026-11-27): how long each step of a session took ON THIS DEVICE,
 * so a slow tablet (iPad mini 4) can be measured without a Mac attached. A code and numbers only:
 * never a photo, a face, a token or a session id. The numbers are shown to staff on the booth
 * (help menu, or `?perf=1`) and go to the server log with the heartbeat (`kiosk_perf`).
 *
 * Pure: the clock is injected, nothing here touches the DOM. `mirror` (optional) copies each span
 * into the browser's own User Timing buffer (`performance.measure`), for a Web Inspector timeline.
 */

/** Every span the booth records. The server accepts these codes and no others. */
export const PERF_CODES = [
  // Loading, once per page load.
  "boot_fonts",
  "boot_assets",
  "boot_samples",
  "boot_luts",
  // A tap (or an automatic step) until the next screen has been painted.
  "screen_welcome",
  "screen_pick",
  "screen_options",
  "screen_camera",
  "screen_ready",
  "screen_review",
  "screen_select",
  "screen_consent",
  "screen_delivery",
  "screen_mobile",
  "screen_attract",
  // Canvas work.
  "thumbs", // the frame picker's previews, when any had to be drawn on entry
  "option_preview", // one options-screen preview drawn on the spot
  "camera_start", // getUserMedia until the stream is live
  "capture_grab", // one shot: the frame taken from the camera
  "capture_total", // one shot: grab + its JPEG for the screen
  "graded_shots", // the shots redrawn in a colour look (review / choice screens)
  "look_row", // the colour row's chips
  "stages", // skin retouch (photo stages) before the frame
  "compose", // composeFrame: the final picture
  "encode", // the final picture as JPEG
  // Network.
  "upload", // queued → the server's answer (a real token)
  "qr", // the QR drawn from the server's link
  "finish", // photos chosen → the QR ready to show (the guest's own time at the wall question is not in it)
] as const;

export type PerfCode = (typeof PERF_CODES)[number];

const CODES = new Set<string>(PERF_CODES);

export function isPerfCode(value: unknown): value is PerfCode {
  return typeof value === "string" && CODES.has(value);
}

/** What staff read on the booth (Korean, like the rest of the help menu). */
export const PERF_LABELS: Record<PerfCode, string> = {
  boot_fonts: "시작 · 글꼴",
  boot_assets: "시작 · 틀 그림",
  boot_samples: "시작 · 예시 사진",
  boot_luts: "시작 · 색감 파일",
  screen_welcome: "화면 · 시작 선택",
  screen_pick: "화면 · 틀 고르기",
  screen_options: "화면 · 틀 옵션",
  screen_camera: "화면 · 카메라 켜는 중",
  screen_ready: "화면 · 촬영 준비",
  screen_review: "화면 · 사진 확인",
  screen_select: "화면 · 사진 고르기",
  screen_consent: "화면 · 미디어월 질문",
  screen_delivery: "화면 · QR",
  screen_mobile: "화면 · 휴대폰 참여",
  screen_attract: "화면 · 처음",
  thumbs: "틀 미리보기 그리기",
  option_preview: "옵션 미리보기 그리기",
  camera_start: "카메라 준비",
  capture_grab: "한 컷 · 찍기",
  capture_total: "한 컷 · 찍기 + 저장",
  graded_shots: "색감 입힌 사진 그리기",
  look_row: "색감 줄 그리기",
  stages: "피부 보정",
  compose: "최종 합성",
  encode: "최종 JPEG 만들기",
  upload: "업로드 → 서버 응답",
  qr: "QR 그리기",
  finish: "사진 확정 → QR 준비 (전체)",
};

/** A span longer than this is a mistake (a tab left in the background), not a measurement. */
export const PERF_MAX_MS = 600_000;
/** Samples kept per code: enough for a median over a few guests, small enough to forget. */
export const PERF_KEEP = 30;

export interface PerfRow {
  code: PerfCode;
  /** Samples since the page loaded (all of them, not only the ones kept). */
  count: number;
  /** Milliseconds, whole numbers. `median` is over the samples kept. */
  last: number;
  median: number;
  max: number;
}

/** What one heartbeat carries for one code: the samples since the previous beat. */
export interface PerfBeat {
  n: number;
  last: number;
  max: number;
  med: number;
}

export type PerfReport = Partial<Record<PerfCode, PerfBeat>>;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export class PerfLog {
  private readonly kept = new Map<PerfCode, number[]>();
  private readonly counts = new Map<PerfCode, number>();
  private readonly maxes = new Map<PerfCode, number>();
  /** Samples not yet sent with a heartbeat. */
  private readonly unsent = new Map<PerfCode, number[]>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(
    private readonly now: () => number = () => performance.now(),
    /** Copies a span into the browser's User Timing buffer. Failures are ignored. */
    private readonly mirror?: (code: PerfCode, startMs: number, durationMs: number) => void,
  ) {}

  /** One finished span. Anything that is not a sane duration is dropped, never stored. */
  record(code: PerfCode, ms: number): void {
    if (!isPerfCode(code) || !Number.isFinite(ms) || ms < 0 || ms > PERF_MAX_MS) return;
    const value = Math.round(ms);
    const kept = this.kept.get(code) ?? [];
    kept.push(value);
    if (kept.length > PERF_KEEP) kept.shift();
    this.kept.set(code, kept);
    this.counts.set(code, (this.counts.get(code) ?? 0) + 1);
    this.maxes.set(code, Math.max(this.maxes.get(code) ?? 0, value));
    const unsent = this.unsent.get(code) ?? [];
    unsent.push(value);
    if (unsent.length > PERF_KEEP) unsent.shift();
    this.unsent.set(code, unsent);
    try {
      this.mirror?.(code, this.now() - ms, ms);
    } catch {
      // The mirror is a convenience for a debugger; it must never break the booth.
    }
    this.version++;
    for (const listener of this.listeners) listener();
  }

  /** Starts a span now; call the returned function when it is over (calling it twice counts once). */
  start(code: PerfCode): () => void {
    const from = this.now();
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      this.record(code, this.now() - from);
    };
  }

  /** Times a synchronous piece of work and hands back its result. */
  time<T>(code: PerfCode, work: () => T): T {
    const stop = this.start(code);
    try {
      return work();
    } finally {
      stop();
    }
  }

  /** The table staff read: every code that has a sample, in PERF_CODES order. */
  rows(): PerfRow[] {
    const rows: PerfRow[] = [];
    for (const code of PERF_CODES) {
      const kept = this.kept.get(code);
      if (!kept?.length) continue;
      rows.push({
        code,
        count: this.counts.get(code) ?? kept.length,
        last: kept[kept.length - 1]!,
        median: median(kept),
        max: this.maxes.get(code) ?? Math.max(...kept),
      });
    }
    return rows;
  }

  /** The samples since the last call, for the heartbeat; null when there are none. */
  take(): PerfReport | null {
    if (this.unsent.size === 0) return null;
    const report: PerfReport = {};
    for (const [code, values] of this.unsent)
      report[code] = {
        n: values.length,
        last: values[values.length - 1]!,
        max: Math.max(...values),
        med: median(values),
      };
    this.unsent.clear();
    return report;
  }

  /** For a screen that shows the table live (useSyncExternalStore). */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Changes with every sample: a cheap snapshot for useSyncExternalStore. */
  getVersion = (): number => this.version;
}

/**
 * A heartbeat's `perf` as the server may log it: known codes, whole sane numbers, nothing else.
 * Anything odd is dropped. Null when nothing usable is left.
 */
export function cleanPerfReport(input: unknown): PerfReport | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const whole = (value: unknown, max: number): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max
      ? Math.round(value)
      : null;
  const report: PerfReport = {};
  let any = false;
  for (const [code, beat] of Object.entries(input as Record<string, unknown>)) {
    if (!isPerfCode(code) || !beat || typeof beat !== "object") continue;
    const { n, last, max, med } = beat as Record<string, unknown>;
    const count = whole(n, 10_000);
    const a = whole(last, PERF_MAX_MS);
    const b = whole(max, PERF_MAX_MS);
    const c = whole(med, PERF_MAX_MS);
    if (!count || a === null || b === null || c === null) continue;
    report[code] = { n: count, last: a, max: b, med: c };
    any = true;
  }
  return any ? report : null;
}

/** One line for the server log: `code=n:last/med/max` per code, in PERF_CODES order. */
export function formatPerfReport(report: PerfReport): string {
  const parts: string[] = [];
  for (const code of PERF_CODES) {
    const beat = report[code];
    if (beat) parts.push(`${code}=${beat.n}:${beat.last}/${beat.med}/${beat.max}`);
  }
  return parts.join(" ");
}

let shared: PerfLog | null = null;

/** The booth's one log (browser only), mirrored into User Timing as `ftl:<code>`. */
export function boothPerf(): PerfLog {
  shared ??= new PerfLog(
    () => performance.now(),
    (code, start, duration) => {
      if (typeof performance.measure !== "function") return;
      const name = `ftl:${code}`;
      // Keep the browser's buffer from growing all day: one entry per code is enough to look at.
      performance.clearMeasures?.(name);
      performance.measure(name, { start: Math.max(0, start), duration });
    },
  );
  return shared;
}
