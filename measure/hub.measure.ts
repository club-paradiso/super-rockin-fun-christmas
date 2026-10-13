import { readFile, readdir, readlink, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { MEASURE_ENV, MEASURE_OUT, MEASURE_PIN, MEASURE_PORT, MEASURE_SETUP_CODE } from "./env";
import { syntheticStrip } from "./images";

/**
 * Phase 4 measurements on a production hub seeded by measure/seed.ts (thousands of photos).
 *
 * 1. load: timings of what staff, the booth and the wall do, on the full database.
 * 2. soak: the wall at 3840×1080 for SOAK_MINUTES (default 5) while the booth keeps adding
 *    photos and staff keep approving and hiding. Every minute: JS heap after GC, DOM nodes,
 *    listeners, frame rate, photos on screen, page reloads, hub memory.
 *
 * Numbers are written to MEASURE_OUT as JSON; docs/measurements/*.md interpret them.
 */
test.describe.configure({ mode: "serial" });

const ORIGIN = `http://127.0.0.1:${MEASURE_PORT}`;
const DATA = MEASURE_ENV.FTL_DATA_DIR!;
const SOAK_MINUTES = Number(process.env.SOAK_MINUTES ?? 5);
let staff: Page;
let kiosk: Page;

// ── helpers ────────────────────────────────────────────────────────────────────────────────
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return +(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0).toFixed(1);
};
const summary = (xs: number[]) => ({
  n: xs.length,
  p50: pct(xs, 50),
  p95: pct(xs, 95),
  max: +Math.max(...xs).toFixed(1),
});
async function timeIt(fn: () => Promise<unknown>) {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}
async function out(name: string, data: unknown) {
  await mkdir(MEASURE_OUT, { recursive: true });
  await writeFile(path.join(MEASURE_OUT, name), JSON.stringify(data, null, 2) + "\n");
}
async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? await dirBytes(p) : (await stat(p)).size;
  }
  return total;
}
/** Resident memory (MB) of the process listening on the hub port (Linux /proc). */
async function hubRssMb(): Promise<number | null> {
  const hex = MEASURE_PORT.toString(16).toUpperCase().padStart(4, "0");
  const tcp = await readFile("/proc/net/tcp", "utf8").catch(() => "");
  const line = tcp.split("\n").find((l) => l.includes(`:${hex} `) && / 0A /.test(l));
  const inode = line?.trim().split(/\s+/)[9];
  if (!inode) return null;
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
    for (const fd of fds) {
      if ((await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "")) === `socket:[${inode}]`) {
        const status = await readFile(`/proc/${pid}/status`, "utf8");
        const kb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1]);
        return Math.round(kb / 1024);
      }
    }
  }
  return null;
}
async function typePin(page: Page, pin: string) {
  for (const d of pin) await page.getByRole("button", { name: d, exact: true }).click();
}
async function enroll(page: Page, label: string, next?: "wall") {
  await staff.goto("/admin/kiosks");
  await staff.getByLabel("새 키오스크 이름").fill(label);
  await staff.getByTestId("create-enrollment-code").click();
  const code = (await staff.getByTestId("enrollment-code").textContent())!.trim();
  await page.goto(next ? "/kiosk/enroll?next=wall" : "/kiosk/enroll");
  await page.getByLabel("등록 코드").fill(code);
  await page.getByRole("button", { name: "이 기기 등록" }).click();
  await expect(page).toHaveURL(next ? /\/wall$/ : /\/kiosk$/);
}
async function db() {
  return JSON.parse(await readFile(path.join(DATA, "db.json"), "utf8")) as {
    photos: { id: string; sessionId: string; moderationStatus: string; wallConsent: boolean }[];
    audit: unknown[];
    wallExposures?: { photoId: string; shownCount: number }[];
  };
}
const staffPost = (req: APIRequestContext, url: string, data: unknown) =>
  req.post(url, { data, headers: { origin: ORIGIN } });

/** Booth upload + "yes" to the wall, the way the kiosk does it. Returns the session id. */
async function boothPhoto(n: number) {
  const sessionId = randomUUID();
  const up = await kiosk.request.post("/api/photos", {
    data: await syntheticStrip(n),
    headers: {
      "content-type": "image/jpeg",
      "x-session-id": sessionId,
      "x-frame-id": "starlight-strip",
      origin: ORIGIN,
    },
  });
  expect(up.status()).toBe(201);
  const c = await kiosk.request.post("/api/photos/consent", {
    data: { sessionId, consent: true },
    headers: { origin: ORIGIN },
  });
  expect(c.status()).toBe(200);
  return sessionId;
}

// ── 1. load ────────────────────────────────────────────────────────────────────────────────
test("load: staff, booth and wall on a hub with thousands of photos", async ({ browser }) => {
  staff = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await staff.goto("/admin/login");
  await staff.getByLabel("설정 코드").fill(MEASURE_SETUP_CODE);
  await staff.getByLabel("이름").fill("측정 책임자");
  await typePin(staff, MEASURE_PIN);
  await staff.getByRole("button", { name: "첫 스태프 만들기" }).click();
  await expect(staff).toHaveURL(/\/admin$/);
  kiosk = await (await browser.newContext()).newPage();
  await enroll(kiosk, "측정 부스");
  const display = await (await browser.newContext()).newPage();
  await enroll(display, "측정 디스플레이 A", "wall");
  await display.goto("about:blank"); // stop its own polling; we call the feed ourselves

  const before = await db();
  const rssStart = await hubRssMb();
  const r: Record<string, unknown> = {
    photos: before.photos.length,
    byStatus: before.photos.reduce<Record<string, number>>((a, p) => {
      a[p.moderationStatus] = (a[p.moderationStatus] ?? 0) + 1;
      return a;
    }, {}),
    auditEvents: before.audit.length,
    dbJsonBytes: (await stat(path.join(DATA, "db.json"))).size,
    objectBytes: await dirBytes(path.join(DATA, "objects")),
    hubRssMbStart: rssStart,
  };

  // Staff reads (warm up once, then time).
  const reads: Record<string, string> = {
    "GET /api/admin/overview": "/api/admin/overview",
    "GET /api/admin/photos?status=PENDING&limit=60": "/api/admin/photos?status=PENDING&limit=60",
    "GET /api/admin/photos?limit=60": "/api/admin/photos?limit=60",
    "page /admin": "/admin",
    "page /admin/moderation": "/admin/moderation",
    "page /admin/photos": "/admin/photos",
    "page /admin/sessions": "/admin/sessions",
    "page /admin/audit": "/admin/audit",
  };
  const readTimes: Record<string, ReturnType<typeof summary>> = {};
  for (const [name, url] of Object.entries(reads)) {
    await staff.request.get(url);
    const xs: number[] = [];
    for (let k = 0; k < 15; k++)
      xs.push(await timeIt(async () => expect((await staff.request.get(url)).status()).toBe(200)));
    readTimes[name] = summary(xs);
  }
  r.staffReads = readTimes;

  // Wall feed (an enrolled display; its limit is 30 a minute, the wall itself polls 12).
  const feedXs: number[] = [];
  let feedIds: string[] = [];
  for (let k = 0; k < 20; k++)
    feedXs.push(
      await timeIt(async () => {
        const res = await display.request.get("/api/wall/feed?slots=8");
        expect(res.status()).toBe(200);
        feedIds = ((await res.json()) as { photos: { id: string }[] }).photos.map((p) => p.id);
      }),
    );
  r.wallFeed = { ...summary(feedXs), idsReturned: feedIds.length };

  // Wall image: first request makes the 1400 px copy, the second reads it.
  const cold: number[] = [];
  const warm: number[] = [];
  for (const id of feedIds.slice(0, 10)) {
    cold.push(await timeIt(() => display.request.get(`/api/wall/photos/${id}/image`)));
    warm.push(await timeIt(() => display.request.get(`/api/wall/photos/${id}/image`)));
  }
  r.wallImageFirst = summary(cold);
  r.wallImageCached = summary(warm);

  // Writes on the full database: booth upload + consent, staff approve.
  const uploadXs: number[] = [];
  const sessions: string[] = [];
  for (let k = 0; k < 20; k++)
    uploadXs.push(await timeIt(async () => sessions.push(await boothPhoto(k))));
  r.boothUploadPlusConsent = summary(uploadXs);
  const now = await db();
  const ids = sessions.map((s) => now.photos.find((p) => p.sessionId === s)!.id);
  const approveXs: number[] = [];
  for (const id of ids)
    approveXs.push(
      await timeIt(async () =>
        expect(
          (
            await staffPost(staff.request, `/api/admin/photos/${id}/moderate`, {
              action: "approve",
            })
          ).status(),
        ).toBe(200),
      ),
    );
  r.staffApprove = summary(approveXs);

  // Everyone at once: 5 approvals of pending photos, 3 uploads, feed polls, overview reads.
  const pending = now.photos.filter((p) => p.moderationStatus === "PENDING").slice(0, 5);
  const burst = await Promise.all([
    ...pending.map((p) =>
      timeIt(() =>
        staffPost(staff.request, `/api/admin/photos/${p.id}/moderate`, { action: "approve" }),
      ),
    ),
    ...[0, 1, 2].map((k) => timeIt(() => boothPhoto(100 + k))),
    ...[0, 1, 2].map(() => timeIt(() => display.request.get("/api/wall/feed?slots=8"))),
    ...[0, 1, 2].map(() => timeIt(() => staff.request.get("/api/admin/overview"))),
  ]);
  r.burst14Concurrent = summary(burst);

  // USB backup: first full mirror, then an incremental run.
  const full = await timeIt(async () =>
    expect((await staffPost(staff.request, "/api/admin/backup", {})).status()).toBe(200),
  );
  const again = await timeIt(async () =>
    expect((await staffPost(staff.request, "/api/admin/backup", {})).status()).toBe(200),
  );
  r.backupMs = { first: Math.round(full), incremental: Math.round(again) };
  r.backupBytes = await dirBytes(MEASURE_ENV.HUB_BACKUP_DIR!);
  r.hubRssMbEnd = await hubRssMb();
  await out("load.json", r);
  console.log(JSON.stringify(r, null, 2));
});

// ── 2. soak ────────────────────────────────────────────────────────────────────────────────
test("soak: the wall runs for SOAK_MINUTES while the evening goes on", async ({ browser }) => {
  test.skip(SOAK_MINUTES <= 0, "SOAK_MINUTES=0");
  const wallCtx: BrowserContext = await browser.newContext({
    viewport: { width: 3840, height: 1080 },
  });
  const wall = await wallCtx.newPage();
  await enroll(wall, "측정 미디어월", "wall");
  let navigations = 0;
  let crashed = 0;
  let consoleErrors = 0;
  const errors: string[] = [];
  wall.on("framenavigated", (f) => {
    if (f === wall.mainFrame()) navigations++;
  });
  wall.on("crash", () => crashed++);
  wall.on("console", (m) => {
    if (m.type() === "error") {
      consoleErrors++;
      if (errors.length < 20) errors.push(m.text().slice(0, 200));
    }
  });
  wall.on("pageerror", (e) => {
    consoleErrors++;
    if (errors.length < 20) errors.push(String(e).slice(0, 200));
  });
  await wall.goto("/wall?canvas=3840x1080");
  await expect(wall.getByTestId("wall-photo").first()).toBeVisible({ timeout: 60_000 });
  navigations = 0; // count only reloads from here on
  const cdp = await wallCtx.newCDPSession(wall);
  await cdp.send("Performance.enable");

  const samples: Record<string, number | null>[] = [];
  const started = Date.now();
  const end = started + SOAK_MINUTES * 60_000;
  let added = 0;
  let hidden = 0;
  let minute = 0;
  while (Date.now() < end) {
    minute++;
    // The evening goes on: a new approved photo every 3 minutes, a hide every 15.
    if (minute % 3 === 0) {
      const s = await boothPhoto(200 + minute);
      const id = (await db()).photos.find((p) => p.sessionId === s)!.id;
      await staffPost(staff.request, `/api/admin/photos/${id}/moderate`, { action: "approve" });
      added++;
    }
    if (minute % 15 === 0) {
      const onScreen = await wall
        .locator('[data-testid="wall-photo"][data-phase="VISIBLE"]')
        .first()
        .getAttribute("data-photo-id")
        .catch(() => null);
      if (onScreen) {
        await staffPost(staff.request, `/api/admin/photos/${onScreen}/moderate`, {
          action: "hide",
        });
        hidden++;
      }
    }
    await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
    const { metrics } = (await cdp.send("Performance.getMetrics")) as {
      metrics: { name: string; value: number }[];
    };
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    const fps = await wall
      .evaluate(
        () =>
          new Promise<number>((resolve) => {
            let n = 0;
            const t0 = performance.now();
            const tick = () => {
              n++;
              if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
              else resolve((n * 1000) / (performance.now() - t0));
            };
            requestAnimationFrame(tick);
          }),
      )
      .catch(() => null);
    const visible = await wall
      .locator('[data-testid="wall-photo"][data-phase="VISIBLE"]')
      .count()
      .catch(() => null);
    samples.push({
      minute: Math.round((Date.now() - started) / 60_000),
      heapUsedMb: +(m.JSHeapUsedSize! / 1048576).toFixed(2),
      heapTotalMb: +(m.JSHeapTotalSize! / 1048576).toFixed(2),
      domNodes: m.Nodes ?? null,
      listeners: m.JSEventListeners ?? null,
      documents: m.Documents ?? null,
      fps: fps === null ? null : +fps.toFixed(1),
      visible,
      reloads: navigations,
      hubRssMb: await hubRssMb(),
    });
    await out("soak.json", {
      minutesPlanned: SOAK_MINUTES,
      canvas: "3840x1080",
      photosAddedDuringRun: added,
      photosHiddenDuringRun: hidden,
      crashed,
      consoleErrors,
      errors,
      samples,
    });
    const wait = started + minute * 60_000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, end - Date.now())));
  }

  // Fairness on the real run: how often each approved photo was shown.
  // Exposure reports are saved lazily (at most every 30 s, lib/storage/local-backend.ts).
  await new Promise((r) => setTimeout(r, 35_000));
  const final = await db();
  const exposures = new Map((final.wallExposures ?? []).map((e) => [e.photoId, e.shownCount]));
  const eligible = final.photos.filter((p) => p.moderationStatus === "APPROVED" && p.wallConsent);
  const shown = eligible.map((p) => exposures.get(p.id) ?? 0);
  await out("soak.json", {
    minutesPlanned: SOAK_MINUTES,
    canvas: "3840x1080",
    photosAddedDuringRun: added,
    photosHiddenDuringRun: hidden,
    crashed,
    consoleErrors,
    errors,
    samples,
    exposure: {
      eligibleAtEnd: eligible.length,
      shownAtLeastOnce: shown.filter((n) => n > 0).length,
      min: Math.min(...shown),
      max: Math.max(...shown),
      totalShowings: shown.reduce((a, b) => a + b, 0),
    },
  });
  expect(crashed).toBe(0);
});
