import { expect, test, type Page } from "@playwright/test";
import { KIOSK_COPY } from "../lib/kiosk/copy";
import { SHOOT_TIMEOUT, enrollKiosk } from "./helpers";

/**
 * The booth on tablets, portrait and landscape (Chromium at tablet sizes; this is not iPad
 * Safari, and it says nothing about a real device). One whole session per viewport, attract to
 * QR, and at every screen the same layout rules:
 *
 *  - nothing is wider than the screen;
 *  - every control is on screen, or can be reached by scrolling the booth's one scroll area,
 *    and a touch in its middle lands on it (nothing invisible lies on top);
 *  - no two controls overlap, and no tape or seal lies on one;
 *  - every control is at least 48 × 48 CSS px, and no label is cut off;
 *  - the camera preview and the photos are 4:3, frames are drawn whole (never stretched);
 *  - the QR is square and fully on screen.
 *
 * At the sizes in MATRIX the screens are also expected to fit without scrolling at all.
 */

const MATRIX = [
  { width: 820, height: 1180 }, // iPad Air 4 portrait
  { width: 1180, height: 820 }, // iPad Air 4 landscape
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 600, height: 960 },
  { width: 820, height: 1060 }, // iPad Air 4 portrait with Safari's toolbars showing
];

interface LayoutReport {
  overflowX: number;
  scrollY: number;
  unreachable: string[];
  covered: string[];
  overlaps: string[];
  small: string[];
  cutLabels: string[];
  decoration: string[];
  distorted: string[];
  qr: string[];
}

/** Measured in the page. Self-contained: Playwright serialises it. */
function measureLayout(): LayoutReport {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const vh = window.innerHeight;
  const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].pop() ?? null;
  const root: ParentNode = dialog ?? document;
  const scroller = document.querySelector<HTMLElement>("[data-booth-scroll]")!;
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  const name = (el: HTMLElement) =>
    (el.dataset.testid || el.getAttribute("aria-label") || el.textContent || el.tagName)
      .trim()
      .slice(0, 28);
  /** The part of an element that its scrolling ancestors leave visible. */
  const visibleBox = (el: Element) => {
    const r = el.getBoundingClientRect();
    const box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    for (let p = el.parentElement; p && p !== de; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const pr = p.getBoundingClientRect();
      box.left = Math.max(box.left, pr.left);
      box.right = Math.min(box.right, pr.right);
      box.top = Math.max(box.top, pr.top);
      box.bottom = Math.min(box.bottom, pr.bottom);
    }
    return box;
  };
  const scrollParent = (el: Element): HTMLElement | null => {
    for (let p = el.parentElement; p && p !== de; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/auto|scroll/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1) return p;
    }
    return null;
  };

  const controls = [...root.querySelectorAll<HTMLElement>("button, a[href], select, input")].filter(
    (el) => shown(el) && el.dataset.testid !== "help-corner",
  );
  const out: LayoutReport = {
    overflowX: Math.max(
      de.scrollWidth - de.clientWidth,
      scroller.scrollWidth - scroller.clientWidth,
    ),
    scrollY: Math.max(
      de.scrollHeight - de.clientHeight,
      scroller.scrollHeight - scroller.clientHeight,
    ),
    unreachable: [],
    covered: [],
    overlaps: [],
    small: [],
    cutLabels: [],
    decoration: [],
    distorted: [],
    qr: [],
  };

  for (const el of controls) {
    const r = el.getBoundingClientRect();
    // A touch in the middle of a control on screen must land on that control: nothing invisible
    // (a hot corner, an overlay) may lie on top of it.
    const [cx, cy] = [r.left + r.width / 2, r.top + r.height / 2];
    if (cx >= 0 && cx <= vw && cy >= 0 && cy <= vh) {
      const hit = document.elementFromPoint(cx, cy);
      if (hit && !el.contains(hit) && !hit.contains(el))
        out.covered.push(`${name(el)} is under ${name(hit as HTMLElement)}`);
    }
    if (r.left < -0.5 || r.right > vw + 0.5) out.unreachable.push(`${name(el)}: off the side`);
    else if (r.top < -0.5 || r.bottom > vh + 0.5) {
      // Below (or above) the fold: fine only inside an area that scrolls far enough to show it.
      const area = scrollParent(el);
      const reach =
        area &&
        (area === scroller || scroller.contains(area)) &&
        r.top - area.getBoundingClientRect().top + area.scrollTop >= -0.5 &&
        r.bottom - area.getBoundingClientRect().top + area.scrollTop <= area.scrollHeight + 0.5;
      if (!reach) out.unreachable.push(`${name(el)}: off screen and not scrollable to`);
    }
    if (r.width < 47.5 || r.height < 47.5)
      out.small.push(`${name(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
      out.cutLabels.push(name(el));
  }
  for (const label of root.querySelectorAll<HTMLElement>(".pick-tile-label")) {
    if (label.scrollWidth > label.clientWidth + 1)
      out.cutLabels.push(`tile "${label.textContent}"`);
  }
  const boxes = controls.map((el) => ({ el, box: visibleBox(el) }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [a, b] = [boxes[i]!, boxes[j]!];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const h = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      if (w > 1 && h > 1) out.overlaps.push(`${name(a.el)} × ${name(b.el)}`);
    }
  }
  for (const d of root.querySelectorAll<HTMLElement>(".tape, .wax-seal")) {
    if (!shown(d)) continue;
    const dr = d.getBoundingClientRect();
    for (const { el, box } of boxes) {
      const w = Math.min(dr.right, box.right) - Math.max(dr.left, box.left);
      const h = Math.min(dr.bottom, box.bottom) - Math.max(dr.top, box.top);
      if (w > 2 && h > 2) out.decoration.push(`${d.className} on ${name(el)}`);
    }
  }

  // Pictures. A 4:3 box that crops (cover) or a box that shows the whole frame (contain): both
  // keep the picture's shape. Anything else stretches it.
  const ratio = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width / r.height;
  };
  const preview = document.querySelector('[data-testid="camera-preview-box"]');
  if (preview && Math.abs(ratio(preview) - 4 / 3) > 0.015)
    out.distorted.push(`camera preview ${ratio(preview).toFixed(3)}`);
  const video = document.querySelector<HTMLVideoElement>('[data-testid="camera-preview"]');
  if (video && getComputedStyle(video).objectFit !== "cover")
    out.distorted.push("preview not cover");
  for (const img of root.querySelectorAll<HTMLImageElement>("main img")) {
    if (!shown(img) || img.dataset.testid === "wax-seal" || !img.naturalWidth) continue;
    const fit = getComputedStyle(img).objectFit;
    const natural = img.naturalWidth / img.naturalHeight;
    const boxed = ratio(img);
    const sameShape = Math.abs(boxed - natural) / natural < 0.03;
    if (!sameShape && fit !== "cover" && fit !== "contain")
      out.distorted.push(
        `${img.dataset.testid ?? img.alt ?? "img"} box ${boxed.toFixed(2)} ≠ ${natural.toFixed(2)}`,
      );
    // A cropped photo sits in a 4:3 box: the crop the guest saw in the preview.
    if (fit === "cover" && Math.abs(boxed - 4 / 3) > 0.03)
      out.distorted.push(`${img.alt || "photo"} cropped to ${boxed.toFixed(2)}, not 4:3`);
  }

  for (const qr of document.querySelectorAll<HTMLElement>(
    '[data-testid="qr-code"], [data-testid="mobile-qr"]',
  )) {
    const r = qr.getBoundingClientRect();
    if (r.top < 0 || r.left < 0 || r.bottom > vh || r.right > vw)
      out.qr.push("QR not fully on screen");
    if (Math.abs(r.width - r.height) > 2) out.qr.push(`QR ${r.width}×${r.height} is not square`);
    if (r.width < 180) out.qr.push(`QR only ${Math.round(r.width)} px`);
    const svg = qr.querySelector("svg");
    if (!svg || svg.getBoundingClientRect().width < 150) out.qr.push("QR drawing missing or tiny");
  }
  return out;
}

async function expectSoundLayout(page: Page, screen: string, { fits = true } = {}) {
  // Let the last layout pass (fonts, a stream's first frame, thumbnails) settle.
  await page.waitForTimeout(250);
  const report = await page.evaluate(measureLayout);
  const { scrollY, ...faults } = report;
  expect(faults, screen).toEqual({
    overflowX: 0,
    unreachable: [],
    covered: [],
    overlaps: [],
    small: [],
    cutLabels: [],
    decoration: [],
    distorted: [],
    qr: [],
  });
  if (fits) expect(scrollY, `${screen}: fits without scrolling`).toBeLessThanOrEqual(1);
  return report;
}

/** One whole session, checked at every screen. */
async function walkSession(page: Page, { lang = "ko" }: { lang?: "ko" | "zh" } = {}) {
  const copy = KIOSK_COPY[lang];
  const at = (screen: string) =>
    expectSoundLayout(page, `${lang === "zh" ? "中文 · " : ""}${screen}`);

  await page.goto("/kiosk?camera=mock");
  await expect(page.getByTestId("screen-attract")).toBeVisible();
  await at("attract");

  await page.getByTestId("attract-start").click();
  await expect(page.getByTestId("screen-welcome")).toBeVisible();
  await at("welcome");
  await page.getByTestId("lang-en").click();
  await at("welcome (English)");
  await page.getByTestId("lang-zh").click();
  await at("welcome (中文)");
  await page.getByTestId(`lang-${lang}`).click();

  await page.getByTestId("start-camera").click();
  {
    await expect(page.getByTestId("screen-pick")).toBeVisible();
    // "이전" sits in the top left corner, where staff hold for help: a tap there is still "이전".
    await page.getByTestId("go-back").click();
    await expect(page.getByTestId("screen-welcome")).toBeVisible();
    await page.getByTestId("start-camera").click();
    await expect(page.getByTestId("frame-preview-image")).toBeVisible();
    await at("frame choice");
    // Every frame is on screen at once: none hidden in a scrolling list.
    for (const tile of await page.getByTestId("frame-options").getByRole("button").all())
      await expect(tile).toBeInViewport({ ratio: 1 });
    await page.getByRole("button", { name: copy.frame.pickConfirm }).click();
  }

  await expect(page.getByTestId("screen-ready")).toBeVisible();
  await expect
    .poll(() => page.getByTestId("camera-preview").evaluate((v: HTMLVideoElement) => v.videoWidth))
    .toBeGreaterThan(0);
  await at("camera ready");
  await expect(page.getByTestId("camera-preview-box")).toBeInViewport({ ratio: 1 });

  await page.getByTestId("shoot-free").click();
  await expect(page.getByTestId("countdown-number")).toBeVisible();
  await at("countdown");
  await expect(page.getByTestId("camera-preview-box")).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId("countdown-number")).toBeInViewport({ ratio: 1 });

  await expect(page.getByTestId("screen-review")).toBeVisible({ timeout: SHOOT_TIMEOUT * 2 });
  for (let i = 0; i < 6; i++)
    await expect(page.getByTestId(`review-shot-${i}`).locator("img")).toBeVisible();
  await at("review");
  await expect(page.getByRole("button", { name: copy.review.confirm })).toBeInViewport({
    ratio: 1,
  });

  await page.getByRole("button", { name: copy.review.confirm }).click();
  await expect(page.getByTestId("screen-frame")).toBeVisible();
  await expect(page.getByTestId("frame-preview-image")).toBeVisible();
  await at("frame, with the photos");
  // A landscape frame and a strip: the large preview shows each whole.
  for (const frame of ["shalom-ticket", "shalom-grid"]) {
    await page.getByTestId(`frame-option-${frame}`).click();
    await expect(page.getByTestId("frame-preview")).toHaveAttribute("data-frame", frame);
    await at(`frame ${frame}`);
  }

  await page.getByRole("button", { name: copy.frame.againConfirm }).click();
  await expect(page.getByTestId("screen-select")).toBeVisible();
  await at("photo selection");
  const required = Number(await page.getByTestId("select-required").getAttribute("data-required"));
  for (let i = 0; i < required; i++) await page.getByTestId(`select-shot-${i}`).click();
  await at("photo selection, chosen");

  await page.getByTestId("confirm-selection").click();
  await expect(page.getByTestId("screen-consent")).toBeVisible();
  await expect(page.getByTestId("final-image")).toBeVisible();
  await at("wall question");
  // Both answers on screen together, the same size.
  const [yes, no] = [page.getByTestId("consent-yes"), page.getByTestId("consent-no")];
  await expect(yes).toBeInViewport({ ratio: 1 });
  await expect(no).toBeInViewport({ ratio: 1 });
  const [yesBox, noBox] = [(await yes.boundingBox())!, (await no.boundingBox())!];
  expect([yesBox.width, yesBox.height]).toEqual([noBox.width, noBox.height]);

  await yes.click();
  await expect(page.getByTestId("delivery-ready")).toBeVisible();
  await expect(page.getByTestId("qr-code").locator("svg")).toBeVisible();
  await at("QR");
  await expect(page.getByTestId("qr-code")).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("button", { name: copy.delivery.done })).toBeInViewport({ ratio: 1 });

  await page.getByRole("button", { name: copy.delivery.done }).click();
  await expect(page.getByTestId("screen-attract")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await enrollKiosk(page);
});

for (const viewport of MATRIX) {
  test(`${viewport.width}×${viewport.height}: a whole session, every screen laid out soundly`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    await walkSession(page);
  });
}

for (const viewport of [MATRIX[0]!, MATRIX[1]!]) {
  test(`${viewport.width}×${viewport.height} Chinese: the same sound layout`, async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize(viewport);
    await walkSession(page, { lang: "zh" });
  });
}

test("the other screens: phone QR, camera refused, the way-home question", async ({ page }) => {
  for (const viewport of [MATRIX[0]!, MATRIX[1]!, MATRIX[4]!]) {
    await page.setViewportSize(viewport);
    const size = `${viewport.width}×${viewport.height}`;
    await page.goto("/kiosk?camera=mock");
    await page.getByTestId("attract-start").click();
    await page.getByTestId("start-mobile").click();
    await expect(page.getByTestId("mobile-qr").locator("svg")).toBeVisible();
    await expectSoundLayout(page, `${size} phone QR`);

    await page.getByTestId("go-home").click();
    await expect(page.getByTestId("screen-attract")).toBeVisible();
    await page.getByTestId("attract-start").click();
    await page.getByTestId("start-camera").click();
    await page.getByTestId("go-home").click();
    await expect(page.getByTestId("confirm-home")).toBeVisible();
    await expectSoundLayout(page, `${size} way-home question`);
    await page.getByTestId("confirm-home-yes").click();
    await expect(page.getByTestId("screen-attract")).toBeVisible();
  }
});

test("camera refused: a screen with a way to try again and a way home, at tablet sizes", async ({
  browser,
}) => {
  const context = await browser.newContext({ permissions: [] });
  const page = await context.newPage();
  await enrollKiosk(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
  });
  for (const viewport of [MATRIX[0]!, MATRIX[1]!]) {
    await page.setViewportSize(viewport);
    await page.goto("/kiosk");
    await page.getByTestId("attract-start").click();
    await page.getByTestId("start-camera").click();
    await page.getByRole("button", { name: "이 틀로 찍기" }).click();
    await expect(page.getByTestId("screen-camera-error")).toBeVisible();
    await expectSoundLayout(page, `${viewport.width}×${viewport.height} camera error`);
    await expect(page.getByRole("button", { name: "다시 시도" })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "처음으로" })).toBeInViewport({ ratio: 1 });
  }
  await context.close();
});

test("turning the tablet: the preview stays 4:3 and on screen, both ways", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto("/kiosk?camera=mock");
  await page.getByTestId("attract-start").click();
  await page.getByTestId("start-camera").click();
  await page.getByRole("button", { name: "이 틀로 찍기" }).click();
  await expect(page.getByTestId("screen-ready")).toBeVisible();
  const box = page.getByTestId("camera-preview-box");
  const shape = async () => {
    const r = (await box.boundingBox())!;
    return r.width / r.height;
  };
  for (const viewport of [
    { width: 1180, height: 820 },
    { width: 820, height: 1180 },
    { width: 1180, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
    await expectSoundLayout(page, `ready after turning to ${viewport.width}×${viewport.height}`);
    expect(await shape()).toBeCloseTo(4 / 3, 1);
    await expect(box).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId("shoot-free")).toBeInViewport({ ratio: 1 });
    // The stream is the one that was running: turning the screen does not restart the camera.
    await expect(page.getByTestId("screen-ready")).toBeVisible();
  }
});

test("a screen too short to fit scrolls inside the booth: nothing is cut off or unreachable", async ({
  page,
}) => {
  // Far shorter than any tablet: the deliberate fallback, not the normal case.
  await page.setViewportSize({ width: 700, height: 460 });
  await page.goto("/kiosk?camera=mock");
  await page.getByTestId("attract-start").click();
  await expect(page.getByTestId("screen-welcome")).toBeVisible();
  const report = await expectSoundLayout(page, "welcome on a very short screen", { fits: false });
  expect(report.scrollY).toBeGreaterThan(0);
  // The page itself never scrolls (Safari's toolbars stay put); the booth's own area does.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
    ),
  ).toBe(0);
  await expect(page.getByTestId("scroll-hint")).toBeVisible();
  // Playwright scrolls the booth's area to reach the switch at the bottom, as a finger would.
  await page.getByTestId("lang-zh").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  await expect(page.getByTestId("lang-zh")).toBeInViewport({ ratio: 1 });

  // A new screen starts at its top, whatever the last one was scrolled to.
  await page.getByTestId("start-camera").click();
  await expect(page.getByTestId("screen-ready")).toBeVisible();
  expect(await page.evaluate(() => document.querySelector("[data-booth-scroll]")!.scrollTop)).toBe(
    0,
  );
  await expectSoundLayout(page, "camera ready on a very short screen", { fits: false });
});

test.describe("finger taps", () => {
  test.use({ hasTouch: true });

  test("a double tap does not press a button on the screen that has just appeared", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto("/kiosk?camera=mock");
    const start = page.getByTestId("attract-start");
    await expect(start).toBeVisible();
    // Past the first moment of the attract screen itself.
    await page.waitForTimeout(500);

    // Two taps in the middle of the first welcome choice's place: the first opens the letter,
    // the second lands where "여기서 사진 찍기" has just appeared.
    await start.tap();
    await expect(page.getByTestId("screen-welcome")).toBeVisible();
    const choice = (await page.getByTestId("start-camera").boundingBox())!;
    await page.touchscreen.tap(choice.x + choice.width / 2, choice.y + choice.height / 2);
    await page.waitForTimeout(200);
    await expect(page.getByTestId("screen-welcome")).toBeVisible();
    await expect(page.locator("main")).toHaveAttribute("data-phase", "welcome");

    // A moment later the same tap is a deliberate one.
    await page.waitForTimeout(400);
    await page.touchscreen.tap(choice.x + choice.width / 2, choice.y + choice.height / 2);
    await expect(page.getByTestId("screen-pick")).toBeVisible();
  });
});
