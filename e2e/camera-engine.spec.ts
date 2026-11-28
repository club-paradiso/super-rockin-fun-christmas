import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { defaultCameraEngine } from "../lib/camera-engine/settings";
import { ENROLL_SECRET } from "./env";
import { SHOOT_TIMEOUT, answerForQr, enrollKiosk, startSession, toConsent } from "./helpers";

/**
 * The Intelligent Camera Engine (lib/camera-engine) in a real browser: the WebGL renderer held
 * to the reference arithmetic, a tilted synthetic wall straightened, the preview showing what
 * the photo gets, one correction per session, sensors read without anyone setting anything, and
 * the booth going on when WebGL is taken away.
 *
 * Desktop Chromium, a drawn wall and the mock camera: it proves the code path and the geometry.
 * It says nothing about the iPad mini 4's sensors, camera or speed (docs/CAMERA_ENGINE.md).
 */

// ── Reading pictures inside the page ───────────────────────────────────────────────────────

/** How far the lab's white middle plumb line leans from vertical, in degrees (signed). */
function plumbLean(page: Page, testId: string): Promise<number> {
  return page.getByTestId(testId).evaluate((canvas: HTMLCanvasElement) => {
    const { width: w, height: h } = canvas;
    const data = canvas.getContext("2d")!.getImageData(0, 0, w, h).data;
    const whiteX = (y: number) => {
      let sum = 0;
      let n = 0;
      // The middle line stays within the middle half of the picture at these tilts.
      for (let x = Math.round(w * 0.25); x < w * 0.75; x++) {
        const i = (y * w + x) * 4;
        // White only: the other lines and the face each have a channel well under 210.
        if (data[i]! > 210 && data[i + 1]! > 210 && data[i + 2]! > 210) {
          sum += x;
          n++;
        }
      }
      return n ? sum / n : Number.NaN;
    };
    const top = Math.round(h * 0.12);
    const bottom = Math.round(h * 0.88);
    return (Math.atan2(whiteX(bottom) - whiteX(top), bottom - top) * 180) / Math.PI;
  });
}

/** Gap between the plumb lines either side of the middle one, near the top ÷ near the bottom. */
function plumbConvergence(page: Page, testId: string): Promise<number> {
  return page.getByTestId(testId).evaluate((canvas: HTMLCanvasElement) => {
    const { width: w, height: h } = canvas;
    const data = canvas.getContext("2d")!.getImageData(0, 0, w, h).data;
    const isPlumb = (x: number, y: number) => {
      const i = (y * w + x) * 4;
      return (
        Math.abs(data[i]! - 159) < 28 &&
        Math.abs(data[i + 1]! - 180) < 28 &&
        Math.abs(data[i + 2]! - 204) < 28
      );
    };
    const gap = (y: number) => {
      const mid = Math.round(w / 2);
      const find = (step: number) => {
        // Past the middle line itself, then outward to the next plumb line.
        for (let x = mid + step * 12; x > 0 && x < w; x += step) if (isPlumb(x, y)) return x;
        return Number.NaN;
      };
      return find(1) - find(-1);
    };
    // Averaged over a few rows clear of the level lines' crossings.
    const rows = (from: number) => [0, 3, 6].map((d) => gap(Math.round(h * from) + d));
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    return mean(rows(0.1)) / mean(rows(0.86));
  });
}

/** Width ÷ height of the lab's round face. */
function faceShape(page: Page, testId: string): Promise<number> {
  return page.getByTestId(testId).evaluate((canvas: HTMLCanvasElement) => {
    const { width: w, height: h } = canvas;
    const data = canvas.getContext("2d")!.getImageData(0, 0, w, h).data;
    let [x0, x1, y0, y1] = [w, 0, h, 0];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (
          Math.abs(data[i]! - 233) < 14 &&
          Math.abs(data[i + 1]! - 180) < 14 &&
          Math.abs(data[i + 2]! - 143) < 14
        ) {
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
      }
    return (x1 - x0 + 1) / (y1 - y0 + 1);
  });
}

/** Darkest of the four corner pixels' brightness: an empty corner would be 0. */
function darkestCorner(page: Page, testId: string): Promise<number> {
  return page.getByTestId(testId).evaluate((canvas: HTMLCanvasElement) => {
    const { width: w, height: h } = canvas;
    const ctx = canvas.getContext("2d")!;
    return Math.min(
      ...[
        [0, 0],
        [w - 1, 0],
        [0, h - 1],
        [w - 1, h - 1],
      ].map(([x, y]) => {
        const p = ctx.getImageData(x!, y!, 1, 1).data;
        return p[0]! + p[1]! + p[2]!;
      }),
    );
  });
}

/**
 * How far the mock camera's white "L" marker leans in a review shot, in degrees. Read off the
 * upright stroke only (the top part of the marker, clear of its foot), in the top half of the
 * picture, where the marker is and the mock's caption is not. The booth is opened with
 * `looks=0` for this: a colour look would tint the white the marker is found by.
 */
function markerLean(page: Page, shot: number): Promise<number> {
  return page
    .getByTestId(`select-shot-${shot}`)
    .locator("img")
    .evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const { width: w, height: h } = canvas;
      const data = ctx.getImageData(0, 0, w, h).data;
      const rows: { y: number; x: number }[] = [];
      for (let y = 0; y < h * 0.5; y++) {
        let sum = 0;
        let n = 0;
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (data[i]! > 236 && data[i + 1]! > 236 && data[i + 2]! > 236) {
            sum += x;
            n++;
          }
        }
        if (n >= 6) rows.push({ y, x: sum / n });
      }
      if (rows.length < 40) return Number.NaN;
      // The upright stroke: from a tenth to six tenths of the marker's height.
      const [y0, y1] = [rows[0]!.y, rows[rows.length - 1]!.y];
      const part = rows.filter((r) => r.y > y0 + (y1 - y0) * 0.1 && r.y < y0 + (y1 - y0) * 0.6);
      const my = part.reduce((a, r) => a + r.y, 0) / part.length;
      const mx = part.reduce((a, r) => a + r.x, 0) / part.length;
      const slope =
        part.reduce((a, r) => a + (r.y - my) * (r.x - mx), 0) /
        part.reduce((a, r) => a + (r.y - my) ** 2, 0);
      return (Math.atan(slope) * 180) / Math.PI;
    });
}

/** Runs in the page before its scripts: this browser has no WebGL (2D canvases still work). */
function noWebGl() {
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    type: string,
    ...rest: unknown[]
  ) {
    if (type === "webgl" || type === "experimental-webgl" || type === "webgl2") return null;
    return (original as (...args: unknown[]) => unknown).call(this, type, ...rest);
  } as typeof original;
}

async function openLab(page: Page, query: string) {
  await page.goto(`/camera-lab?${query}`);
  await expect(page.locator('#camera-lab[data-source="ready"]')).toBeVisible();
  await expect
    .poll(() => page.getByTestId("lab-preview").evaluate((v: HTMLVideoElement) => v.videoWidth))
    .toBeGreaterThan(0);
}

async function testShot(page: Page) {
  await page.getByTestId("lab-shoot").click();
  await expect(page.getByTestId("lab-timing")).toHaveAttribute("data-corrected", /true|false/);
}

// ── The check page ─────────────────────────────────────────────────────────────────────────

test.describe("/camera-lab: the renderer and the geometry", () => {
  test("WebGL draws what the reference arithmetic says, pixel by pixel", async ({ page }) => {
    await page.goto("/camera-lab");
    await page.getByTestId("lab-selftest").click();
    const out = page.getByTestId("lab-selftest-out");
    await expect(out).toHaveAttribute("data-result", "pass");
    // Mean difference under one 8-bit step; fewer than 1 % of values more than 8 steps off
    // (those are on the checkerboard's edges, where the two bilinear filters round apart).
    expect(Number(await out.getAttribute("data-mean"))).toBeLessThan(1);
    expect(Number(await out.getAttribute("data-share"))).toBeLessThan(0.01);
  });

  test("a rolled camera's wall is stood up straight, with no empty corner", async ({ page }) => {
    for (const roll of [8, -5, 15]) {
      await openLab(page, `source=chart&chartTilt=${roll},0&engine=manual&tilt=${roll},0`);
      await testShot(page);
      await expect(page.getByTestId("lab-timing")).toHaveAttribute("data-corrected", "true");
      // The picture is mirrored, like the booth's: the lean shows with the opposite sign.
      expect(Math.abs(await plumbLean(page, "lab-before"))).toBeCloseTo(Math.abs(roll), 0);
      // 15° is held just short by the enlargement limit (docs: about 0.6° is left).
      expect(Math.abs(await plumbLean(page, "lab-after"))).toBeLessThan(roll === 15 ? 0.9 : 0.3);
      // The wall's own colour reaches every corner: nothing black, nothing invented.
      expect(await darkestCorner(page, "lab-after")).toBeGreaterThan(60);
      expect(await faceShape(page, "lab-after")).toBeCloseTo(1, 1);
    }
  });

  test("a pitched camera's converging lines are eased, and the face in the middle stays round", async ({
    page,
  }) => {
    for (const pitch of [14, -14]) {
      await openLab(page, `source=chart&chartTilt=0,${pitch}&engine=manual&tilt=0,${pitch}`);
      await testShot(page);
      const before = await plumbConvergence(page, "lab-before");
      const after = await plumbConvergence(page, "lab-after");
      // Looking up, plumb lines close in toward the top; looking down, toward the bottom.
      if (pitch > 0) expect(before).toBeLessThan(0.97);
      else expect(before).toBeGreaterThan(1.03);
      // Partly corrected on purpose (Portrait Guard, an assumed camera): at least a quarter.
      expect(Math.abs(1 - after)).toBeLessThan(Math.abs(1 - before) * 0.75);
      expect(Math.abs(1 - after)).toBeGreaterThan(0);
      const face = await faceShape(page, "lab-after");
      expect(face).toBeGreaterThan(0.97);
      expect(face).toBeLessThan(1.03);
      expect(Math.abs(await plumbLean(page, "lab-after"))).toBeLessThan(0.3);
      expect(await darkestCorner(page, "lab-after")).toBeGreaterThan(60);
    }
  });

  test("roll and pitch together, on a portrait stream too", async ({ page }) => {
    for (const size of ["1280x720", "720x1280"]) {
      await openLab(
        page,
        `source=chart&chartSize=${size}&chartTilt=-5,10&engine=manual&tilt=-5,10`,
      );
      await testShot(page);
      expect(Math.abs(await plumbLean(page, "lab-before"))).toBeGreaterThan(4);
      expect(Math.abs(await plumbLean(page, "lab-after"))).toBeLessThan(0.3);
      expect(await darkestCorner(page, "lab-after")).toBeGreaterThan(60);
      const line = page.getByTestId("lab-line");
      await expect(line).toHaveAttribute("data-state", "manual");
      await expect(line).toHaveAttribute("data-backend", "webgl");
      expect(Number(await line.getAttribute("data-zoom"))).toBeLessThan(1.16);
    }
  });

  test("the preview shows what the photo gets", async ({ page }) => {
    await openLab(page, "source=chart&chartTilt=9,12&engine=manual&tilt=9,12");
    await testShot(page);
    await expect(page.getByTestId("lab-preview")).toHaveAttribute("data-engine", "on");
    // The measuring lines are on top of the pictures: out of the way for this comparison.
    await page.addStyleTag({ content: ".lab-grid{display:none}" });
    const small = (buffer: Buffer) =>
      sharp(buffer).resize(200, 150, { fit: "fill" }).removeAlpha().raw().toBuffer();
    const canvasPng = async (testId: string) =>
      Buffer.from(
        (
          await page
            .getByTestId(testId)
            .evaluate((c: HTMLCanvasElement) => c.toDataURL("image/png"))
        ).split(",")[1]!,
        "base64",
      );
    const preview = await small(await page.getByTestId("lab-preview-box").screenshot());
    const after = await small(await canvasPng("lab-after"));
    const before = await small(await canvasPng("lab-before"));
    const diff = (a: Buffer, b: Buffer) => {
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
      return sum / a.length;
    };
    // The same picture (a video frame and a canvas differ a little in colour and filtering),
    // and clearly not the uncorrected one.
    expect(diff(preview, after)).toBeLessThan(12);
    expect(diff(preview, after)).toBeLessThan(diff(preview, before) * 0.5);
  });

  test("without a tilt nothing is touched: the photo is taken the way it always was", async ({
    page,
  }) => {
    await openLab(page, "source=chart&chartTilt=6,10&engine=manual&tilt=0,0");
    await testShot(page);
    await expect(page.getByTestId("lab-timing")).toHaveAttribute("data-corrected", "false");
    await expect(page.getByTestId("lab-line")).toHaveAttribute("data-state", "level");
    await expect(page.getByTestId("lab-preview")).not.toHaveAttribute("data-engine", "on");
    const same = await page.evaluate(() => {
      const png = (id: string) => (document.getElementById(id) as HTMLCanvasElement).toDataURL();
      return png("before") === png("after");
    });
    expect(same).toBe(true);
  });

  test("without WebGL only the roll is corrected, by the 2D canvas, and staff are told", async ({
    page,
  }) => {
    await page.addInitScript(noWebGl);
    await openLab(page, "source=chart&chartTilt=8,12&engine=manual&tilt=8,12");
    await testShot(page);
    const line = page.getByTestId("lab-line");
    await expect(line).toHaveAttribute("data-state", "manual");
    await expect(line).toHaveAttribute("data-backend", "canvas2d");
    await expect(line).toHaveAttribute("data-applied-pitch", "0");
    await expect(page.getByTestId("lab-timing")).toHaveAttribute("data-corrected", "true");
    expect(Math.abs(await plumbLean(page, "lab-after"))).toBeLessThan(0.4);
    expect(await darkestCorner(page, "lab-after")).toBeGreaterThan(60);
    await page.getByTestId("lab-selftest").click();
    await expect(page.getByTestId("lab-selftest-out")).toHaveAttribute("data-result", "no-webgl");
  });
});

// ── The booth ──────────────────────────────────────────────────────────────────────────────

/** Fires `deviceorientation` as an upright tablet with this tilt would, twenty times a second. */
async function standAt(page: Page, roll: number, pitch: number) {
  await page.evaluate(
    ({ roll, pitch }) => {
      const r = (roll * Math.PI) / 180;
      const p = (pitch * Math.PI) / 180;
      // "Up" in device coordinates, and the W3C angles that give it.
      const up = [-Math.cos(p) * Math.sin(r), Math.cos(p) * Math.cos(r), Math.sin(p)];
      const w = window as unknown as {
        __tilt?: { beta: number; gamma: number };
        __tiltTimer?: number;
      };
      w.__tilt = {
        beta: (Math.asin(up[1]!) * 180) / Math.PI,
        gamma: (Math.atan2(-up[0]!, up[2]!) * 180) / Math.PI,
      };
      w.__tiltTimer ??= window.setInterval(
        () => window.dispatchEvent(new DeviceOrientationEvent("deviceorientation", w.__tilt)),
        50,
      );
    },
    { roll, pitch },
  );
}

const previewTransform = (page: Page) =>
  page.getByTestId("camera-preview").evaluate((v: HTMLVideoElement) => v.style.transform);

/**
 * The turn-and-scale part of the preview's matrix. The shooting screen gives the preview box
 * another size than the ready screen, which changes the matrix's offsets and nothing else.
 */
async function previewTurn(page: Page): Promise<string> {
  const n = (await previewTransform(page)).slice(9, -1).split(",").map(Number);
  return [n[0], n[1], n[4], n[5]].map((v) => v!.toFixed(4)).join(" ");
}

test.describe("the booth", () => {
  test.beforeEach(async ({ page }) => {
    await enrollKiosk(page);
  });

  test("off (the default): no engine, the preview and the photos as they always were", async ({
    page,
  }) => {
    await page.goto("/kiosk?camera=mock&looks=0");
    await expect(page.locator("main.kiosk-root")).not.toHaveAttribute("data-camera-engine", "on");
    await startSession(page);
    expect(await previewTransform(page)).toBe("scaleX(-1)");
    await expect(page.getByTestId("camera-preview")).not.toHaveAttribute("data-engine", "on");
    await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });
    expect(Math.abs(await markerLean(page, 0))).toBeLessThan(0.3);
  });

  test("manual: every photo of the session gets the same correction", async ({ page }) => {
    test.setTimeout(120_000);
    // 4° of roll: enough to measure, and the mock's marker (near a corner) stays in the
    // picture. No pitch here: easing a perspective rightly turns lines that are off-centre.
    await page.goto("/kiosk?camera=mock&engine=manual&tilt=4,0&looks=0");
    await expect(page.locator("main.kiosk-root")).toHaveAttribute("data-camera-engine", "on");
    await startSession(page);
    await expect(page.getByTestId("camera-preview")).toHaveAttribute("data-engine", "on");
    expect(await previewTransform(page)).toMatch(/^matrix3d\(/);
    const turn = await previewTurn(page);
    await expect(page.getByTestId("countdown-number")).toBeVisible();
    // Fixed while shooting: the preview keeps the correction it had.
    expect(await previewTurn(page)).toBe(turn);
    await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });
    const leans: number[] = [];
    for (let i = 0; i < 4; i++) leans.push(await markerLean(page, i));
    for (const lean of leans) {
      // The camera's picture turned back by the 4° of roll (mirrored, so the sign flips).
      expect(Math.abs(lean)).toBeGreaterThan(3.5);
      expect(Math.abs(lean)).toBeLessThan(4.5);
      expect(Math.abs(lean - leans[0]!)).toBeLessThan(0.3);
    }
  });

  test("with colour looks on, the rest of the booth is untouched: frame, wall question, QR", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto("/kiosk?camera=mock&engine=manual&tilt=10,8");
    await startSession(page);
    await expect(page.getByTestId("camera-preview")).toHaveAttribute("data-engine", "on");
    await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });
    for (let i = 0; i < 4; i++)
      await expect(page.getByTestId(`select-shot-${i}`).locator("img")).toBeVisible();
    await toConsent(page);
    const url = await answerForQr(page, "no");
    expect(url).toMatch(/\/p\//);
    const image = await page.request.get(`${new URL(url).pathname}/image`);
    expect(image.status()).toBe(200);
    expect((await sharp(await image.body()).metadata()).width).toBeGreaterThan(500);
  });

  test("auto: reads the tilt by itself, and holds it through the session whatever happens after", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto("/kiosk?camera=mock&engine=auto&looks=0");
    await standAt(page, 4, 0);
    await startSession(page);
    await expect(page.getByTestId("camera-preview")).toHaveAttribute("data-engine", "on");
    const turn = await previewTurn(page);
    await expect(page.getByTestId("countdown-number")).toBeVisible();
    // Someone leans on the booth for the rest of the session.
    await standAt(page, -12, 15);
    await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });
    for (const shot of [0, 1, 3]) {
      const lean = Math.abs(await markerLean(page, shot));
      expect(lean).toBeGreaterThan(3.5);
      expect(lean).toBeLessThan(4.5);
    }
    // There is no 「다시 찍기」 (2026-11-27): the shots are final, and nothing offers another round.
    await expect(page.getByTestId("retake")).toHaveCount(0);
    // The next guest is measured afresh: the booth now stands the other way.
    await page.getByTestId("go-home").click();
    await page.getByTestId("confirm-home-yes").click();
    await expect(page.getByTestId("screen-attract")).toBeVisible();
    await page.waitForTimeout(2500);
    await startSession(page);
    await expect(page.getByTestId("camera-preview")).toHaveAttribute("data-engine", "on");
    expect(await previewTurn(page)).not.toBe(turn);
  });

  test("auto without any sensor: nothing is corrected and the booth works as ever", async ({
    page,
  }) => {
    await page.goto("/kiosk?camera=mock&engine=auto&looks=0");
    await startSession(page);
    expect(await previewTransform(page)).toBe("scaleX(-1)");
    await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });
    expect(Math.abs(await markerLean(page, 0))).toBeLessThan(0.3);
  });

  test("WebGL taken away: the roll is still corrected and four photos are still taken", async ({
    page,
  }) => {
    await page.addInitScript(noWebGl);
    await page.goto("/kiosk?camera=mock&engine=manual&tilt=4,12&looks=0");
    await startSession(page);
    await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT });
    for (let i = 0; i < 4; i++)
      await expect(page.getByTestId(`select-shot-${i}`).locator("img")).toBeVisible();
    const lean = Math.abs(await markerLean(page, 2));
    expect(lean).toBeGreaterThan(3.5);
    expect(lean).toBeLessThan(4.5);
  });
});

// ── Staff ──────────────────────────────────────────────────────────────────────────────────

test("staff turn it on in /admin: the booth takes it up, and /admin shows what the booth does", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await page.goto("/admin/login");
  await page.getByLabel("비밀번호", { exact: true }).fill(ENROLL_SECRET);
  await page.getByRole("button", { name: "관리자 화면 열기" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  try {
    await page.goto("/admin/settings");
    const form = page.getByTestId("camera-engine-form");
    // Off until someone turns it on.
    await expect(form.getByTestId("camera-engine-mode-off")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(form.getByTestId("camera-engine-roll")).toBeDisabled();
    await form.getByTestId("camera-engine-mode-manual").click();
    await form.getByTestId("camera-engine-roll").fill("6");
    await form.getByTestId("camera-engine-pitch").fill("99");
    await expect(form.getByTestId("camera-engine-invalid")).toBeVisible();
    await expect(form.getByTestId("camera-engine-save")).toBeDisabled();
    await form.getByTestId("camera-engine-pitch").fill("-4");
    await form.getByTestId("camera-engine-save").click();
    await expect(form.getByTestId("camera-engine-message")).toContainText("저장했어요");

    // The change is in the audit log.
    await page.goto("/admin/audit");
    await expect(page.getByTestId("audit-item").first()).toHaveAttribute(
      "data-action",
      "update_settings",
    );

    // A booth that opens now runs with it, and says so with its next heartbeat.
    const context = await browser.newContext();
    const booth = await context.newPage();
    await enrollKiosk(booth);
    await booth.goto("/kiosk?camera=mock");
    await expect(booth.locator("main.kiosk-root")).toHaveAttribute("data-camera-engine", "on");
    await startSession(booth);
    await expect(booth.getByTestId("camera-preview")).toHaveAttribute("data-engine", "on");

    // Found by what it says: a worker restarted after a failed test enrolls a second booth.
    const card = page.getByTestId("kiosk-camera-engine").filter({ hasText: "좌우 +6.0°" });
    await expect
      .poll(
        async () => {
          await page.goto("/admin/kiosks");
          return card.count();
        },
        { timeout: 20_000 },
      )
      .toBe(1);
    await expect(card).toHaveAttribute("data-engine-state", "manual");
    await expect(card).toContainText("수동");
    await card.locator("summary").click();
    await expect(card).toContainText("앞뒤 -4.0°");
    await expect(card).toContainText("추정");
    await context.close();
  } finally {
    // Back to off for every spec after this one (the default the suite runs with).
    const res = await page.request.post("/api/admin/settings", {
      data: { cameraEngine: defaultCameraEngine() },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(res.status()).toBe(200);
  }
  await page.goto("/admin/settings");
  await expect(page.getByTestId("camera-engine-mode-off")).toHaveAttribute("aria-checked", "true");
});
