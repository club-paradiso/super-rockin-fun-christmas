import { expect, request as apiRequest, test, type Page } from "@playwright/test";
import { KIOSK_COPY } from "../lib/kiosk/copy";
import { ENROLL_SECRET, PORT } from "./env";
import { SHOOT_TIMEOUT, enrollKiosk, confirmFrame } from "./helpers";

/**
 * The booth on tablets, portrait and landscape (Chromium at tablet sizes; this is not iPad
 * Safari, and it says nothing about a real device). One whole session per viewport, cover to
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
  for (const label of root.querySelectorAll<HTMLElement>(".pick-tile-label, .pick-card-name")) {
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
  for (const d of root.querySelectorAll<HTMLElement>(
    ".tape, .wax-seal, .journal-spine, .journal-tab, .journal-bookmark",
  )) {
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
  // The preview window has the chosen frame's slot shape (lib/kiosk/preview-shape.ts, its
  // data-aspect); the shot inside it stays 4:3, cut by the window, never stretched.
  const preview = document.querySelector<HTMLElement>('[data-testid="camera-preview-box"]');
  const wanted = Number(preview?.dataset.aspect);
  if (preview && !(Math.abs(ratio(preview) - wanted) / wanted < 0.012))
    out.distorted.push(`camera preview ${ratio(preview).toFixed(3)} ≠ ${wanted}`);
  const view = document.querySelector('[data-testid="camera-preview-view"]');
  if (view && Math.abs(ratio(view) - 4 / 3) > 0.015)
    out.distorted.push(`camera view ${ratio(view).toFixed(3)}`);
  // Centred and covering the window: with both shapes right, the window then shows exactly the
  // centred crop composeFrame makes of each shot (tests/unit/preview-shape.test.ts).
  if (preview && view) {
    // The window's inside (its 1 px border excluded): what the view fills.
    const outer = preview.getBoundingClientRect();
    const w = {
      left: outer.left + preview.clientLeft,
      top: outer.top + preview.clientTop,
      width: preview.clientWidth,
      height: preview.clientHeight,
    };
    const v = view.getBoundingClientRect();
    const covers =
      v.left <= w.left + 1 &&
      v.top <= w.top + 1 &&
      v.right >= w.left + w.width - 1 &&
      v.bottom >= w.top + w.height - 1;
    const centred =
      Math.abs(v.left + v.width / 2 - (w.left + w.width / 2)) <= 1 &&
      Math.abs(v.top + v.height / 2 - (w.top + w.height / 2)) <= 1;
    const tight = Math.min(v.width - w.width, v.height - w.height) <= 2;
    if (!covers || !centred || !tight)
      out.distorted.push("camera view not the frame's centred crop");
  }
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

/**
 * The cover (2026-11-27: it holds what the welcome screen held). Its small controls sit under
 * the start with its two captions, clear of the edition line at the foot of the cover, each at
 * least 52 px tall (D88), and the paused line, when there is one, is with them.
 */
async function expectCoverClear(page: Page, screen: string) {
  // The cover comes in with a short entrance (a scale): measured where it comes to rest.
  await page
    .getByTestId("screen-attract")
    .evaluate((el) =>
      Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)),
    );
  const report = await page.evaluate(() => {
    const box = (selector: string) => {
      const r = document.querySelector(selector)!.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
    };
    const options = document.querySelector<HTMLElement>('[data-testid="attract-options"]')!;
    return {
      start: box(".attract-start"),
      options: box('[data-testid="attract-options"]'),
      edition: box(".journal-cover-edition"),
      inside: [...options.children].map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      }),
      controls: [...options.querySelectorAll<HTMLElement>("button")].map((el) => ({
        name: el.dataset.testid ?? el.textContent ?? "",
        height: el.getBoundingClientRect().height,
      })),
    };
  });
  expect(report.options.top, `${screen}: controls under the start`).toBeGreaterThanOrEqual(
    report.start.bottom,
  );
  expect(report.edition.top, `${screen}: edition line under the controls`).toBeGreaterThanOrEqual(
    report.options.bottom,
  );
  for (const child of report.inside) {
    expect(child.top, `${screen}: inside the controls' box`).toBeGreaterThanOrEqual(
      report.options.top - 0.5,
    );
    expect(child.bottom, `${screen}: inside the controls' box`).toBeLessThanOrEqual(
      report.options.bottom + 0.5,
    );
    expect(child.left, `${screen}: inside the controls' box`).toBeGreaterThanOrEqual(
      report.options.left - 0.5,
    );
    expect(child.right, `${screen}: inside the controls' box`).toBeLessThanOrEqual(
      report.options.right + 0.5,
    );
  }
  expect(report.controls.map((c) => c.name).sort(), screen).toEqual(
    ["lang-en", "lang-ko", "lang-zh", "sound-toggle", "start-mobile"].sort(),
  );
  for (const control of report.controls)
    expect(control.height, `${screen}: ${control.name}`).toBeGreaterThanOrEqual(52);
}

/** The staff switch PAUSE SUBMISSIONS, set as e2e/global-setup.ts sets the review mode. */
async function pauseSubmissions(paused: boolean) {
  const origin = `http://127.0.0.1:${PORT}`;
  const api = await apiRequest.newContext({ baseURL: origin, extraHTTPHeaders: { origin } });
  try {
    const login = await api.post("/api/admin/auth/password", { data: { password: ENROLL_SECRET } });
    expect(login.ok(), "staff login for the switch").toBe(true);
    const res = await api.post("/api/admin/settings", { data: { pauseSubmissions: paused } });
    expect(res.ok(), "PAUSE SUBMISSIONS").toBe(true);
  } finally {
    await api.dispose();
  }
}

/** One whole session, checked at every screen. */
async function walkSession(page: Page, { lang = "ko" }: { lang?: "ko" | "zh" } = {}) {
  const copy = KIOSK_COPY[lang];
  const at = (screen: string) =>
    expectSoundLayout(page, `${lang === "zh" ? "中文 · " : ""}${screen}`);

  await page.goto("/kiosk?camera=mock");
  const cover = page.getByTestId("screen-attract");
  await expect(cover).toBeVisible();
  // The cover holds the start and, under it, what the welcome screen held (2026-11-27): the
  // language, "내 사진으로 참여하기" and the sound switch. Sound in every language, and a touch
  // on one of them starts nothing.
  await at("cover");
  await expectCoverClear(page, "cover");
  await page.getByTestId("lang-en").click();
  await at("cover (English)");
  await expectCoverClear(page, "cover (English)");
  await page.getByTestId("lang-zh").click();
  await at("cover (中文)");
  await expectCoverClear(page, "cover (中文)");
  await page.getByTestId(`lang-${lang}`).click();
  await expect(cover).toBeVisible();
  for (const id of ["lang-ko", "lang-en", "lang-zh", "start-mobile", "sound-toggle"])
    await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 });

  await page.getByTestId("attract-start").click();
  {
    await expect(page.getByTestId("screen-pick")).toBeVisible();
    // "이전" sits in the bottom bar beside "처음으로" (2026-11-25): from the picker it is the cover.
    await page.getByTestId("go-back").click();
    await expect(cover).toBeVisible();
    await expect(page.getByTestId(`lang-${lang}`)).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("attract-start").click();
    await expect(page.getByTestId("frame-option-film").locator("img")).toBeVisible();
    await at("frame choice");
    // Every frame is on screen at once: none hidden in a scrolling list.
    for (const tile of await page.getByTestId("frame-options").getByRole("button").all())
      await expect(tile).toBeInViewport({ ratio: 1 });
    // 필름 (options) is the card marked: the bottom bar's button → the options screen; its four
    // colours on one row, laid out soundly.
    await page.getByRole("button", { name: copy.frame.next }).click();
    await expect(page.getByTestId("screen-options")).toBeVisible();
    await expect(page.getByTestId("frame-preview-image")).toBeVisible();
    // 크림 (four photos): the handwriting preview cycles while the screen is shown.
    await expect(page.getByTestId("frame-preview")).toHaveAttribute("data-hand", "cycling");
    await at("options: film, cream");
    await page.getByTestId("option-color-sepia").click();
    await expect(page.getByTestId("frame-preview")).toHaveAttribute(
      "data-frame",
      "film3-sepia-logo",
    );
    await at("options: film, sepia");
    await page.getByTestId("go-back").click();
    // A tap on a card is its options screen (no second press).
    await page.getByTestId("frame-option-film").click();
    await expect(page.getByTestId("screen-options")).toBeVisible();
    await expect(page.getByTestId("frame-preview")).toHaveAttribute("data-frame", "film4-cream");
    await page.getByRole("button", { name: copy.option.shoot }).click();
  }

  await expect(page.getByTestId("screen-shooting")).toBeVisible();
  await expect
    .poll(() => page.getByTestId("camera-preview").evaluate((v: HTMLVideoElement) => v.videoWidth))
    .toBeGreaterThan(0);
  await at("camera ready");
  await expect(page.getByTestId("camera-preview-box")).toBeInViewport({ ratio: 1 });

  await expect(page.getByTestId("countdown-number")).toBeVisible();
  await at("countdown");
  await expect(page.getByTestId("camera-preview-box")).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId("countdown-number")).toBeInViewport({ ratio: 1 });

  await expect(page.getByTestId("screen-select")).toBeVisible({ timeout: SHOOT_TIMEOUT * 2 });
  for (let i = 0; i < 4; i++)
    await expect(page.getByTestId(`select-shot-${i}`).locator("img")).toBeVisible();
  // The photo choice is the first screen after the shots, and it opens with the first photos
  // chosen: the finish button is on screen and live at once.
  await at("photo selection, as it opens");
  const required = Number(await page.getByTestId("select-required").getAttribute("data-required"));
  for (let i = 0; i < required; i++)
    await expect(page.getByTestId(`select-shot-${i}`)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("select-change-hint")).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId("confirm-selection")).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId("confirm-selection")).toBeEnabled();
  await expect(page.getByTestId("go-back")).toHaveCount(0);
  // Changing it: one out (the button waits), the same one back in (it goes last). Four shots and
  // at most four places: there is no spare photo to put in instead.
  await page.getByTestId("select-shot-0").click();
  await expect(page.getByTestId("confirm-selection")).toBeDisabled();
  await at("photo selection, one taken out");
  await page.getByTestId("select-shot-0").click();
  await expect(page.getByTestId("select-shot-0")).toHaveAttribute("aria-pressed", "true");
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
    // "내 사진으로 참여하기" is on the cover.
    await page.getByTestId("start-mobile").click();
    await expect(page.getByTestId("mobile-qr").locator("svg")).toBeVisible();
    await expectSoundLayout(page, `${size} phone QR`);

    await page.getByTestId("go-home").click();
    await expect(page.getByTestId("screen-attract")).toBeVisible();
    await page.getByTestId("attract-start").click();
    await expect(page.getByTestId("screen-pick")).toBeVisible();
    await page.getByTestId("go-home").click();
    await expect(page.getByTestId("confirm-home")).toBeVisible();
    await expectSoundLayout(page, `${size} way-home question`);
    await page.getByTestId("confirm-home-yes").click();
    await expect(page.getByTestId("screen-attract")).toBeVisible();
  }
});

test("PAUSE SUBMISSIONS: the cover says why the phone button is off, nothing runs into the edition line, and the session has four dots", async ({
  page,
}) => {
  await pauseSubmissions(true);
  try {
    // Landscape first: it has the least height for one more line.
    for (const viewport of [MATRIX[1]!, MATRIX[3]!, MATRIX[2]!, MATRIX[0]!]) {
      await page.setViewportSize(viewport);
      const size = `${viewport.width}×${viewport.height}`;
      await page.goto("/kiosk?camera=mock");
      const cover = page.getByTestId("screen-attract");
      await expect(cover).toBeVisible();
      await expect(page.locator("main")).toHaveAttribute("data-wall-submissions", "paused");
      const mobile = page.getByTestId("start-mobile");
      for (const lang of ["ko", "en", "zh"] as const) {
        await page.getByTestId(`lang-${lang}`).click();
        // The other way in is off, and the reason is said beside it (not only by greying it).
        await expect(mobile).toBeDisabled();
        const why = cover.locator(".attract-mobile-paused");
        await expect(why).toHaveText(KIOSK_COPY[lang].attract.mobilePaused);
        await expect(why).toBeInViewport({ ratio: 1 });
        await expect(mobile).toHaveAttribute("aria-describedby", (await why.getAttribute("id"))!);
        await expectSoundLayout(page, `${size} paused cover (${lang})`);
        await expectCoverClear(page, `${size} paused cover (${lang})`);
      }
      await page.getByTestId("lang-ko").click();
      // Taking photos is not paused: one touch still opens the picker, and the dots count the
      // steps this session really has (no wall question: four).
      await page.getByTestId("attract-start").click();
      await expect(page.getByTestId("screen-pick")).toBeVisible();
      await expect(page.getByTestId("step-progress")).toHaveText("1 / 4");
      await expect(page.locator(".booth-steps-dot")).toHaveCount(4);
    }
  } finally {
    await pauseSubmissions(false);
  }
  // Open again: the phone button is back, the line is gone, five dots.
  await page.goto("/kiosk?camera=mock");
  await expect(page.getByTestId("start-mobile")).toBeEnabled();
  await expect(page.locator(".attract-mobile-paused")).toHaveCount(0);
  await page.getByTestId("attract-start").click();
  await expect(page.getByTestId("step-progress")).toHaveText("1 / 5");
  await expect(page.locator(".booth-steps-dot")).toHaveCount(5);
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
    await confirmFrame(page);
    await expect(page.getByTestId("screen-camera-error")).toBeVisible();
    await expectSoundLayout(page, `${viewport.width}×${viewport.height} camera error`);
    await expect(page.getByRole("button", { name: "다시 시도" })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "처음으로" })).toBeInViewport({ ratio: 1 });
  }
  await context.close();
});

test("turning the tablet: the preview keeps its shape and stays on screen, both ways", async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto("/kiosk?camera=mock");
  await page.getByTestId("attract-start").click();
  await confirmFrame(page);
  await expect(page.getByTestId("screen-shooting")).toBeVisible();
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
    await expectSoundLayout(page, `shooting after turning to ${viewport.width}×${viewport.height}`);
    // The window keeps the frame's slot shape (필름 3컷: about square) whichever way it turns.
    expect(await shape()).toBeCloseTo(Number(await box.getAttribute("data-aspect")), 1);
    await expect(box).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId("shot-label")).toBeInViewport({ ratio: 1 });
    // The stream is the one that was running: turning the screen does not restart the camera.
    await expect(page.getByTestId("screen-shooting")).toBeVisible();
  }
});

test("a screen too short to fit scrolls inside the booth: nothing is cut off or unreachable", async ({
  page,
}) => {
  // Far shorter than any tablet: the deliberate fallback, not the normal case.
  await page.setViewportSize({ width: 700, height: 460 });
  await page.goto("/kiosk?camera=mock");
  // The cover carries the language, the phone button and the sound switch now. In English they
  // take two rows: on a screen this short the cover is the one that has to scroll, and what it
  // must never do instead is draw them over the edition line at its foot.
  const cover = page.getByTestId("screen-attract");
  await expect(cover).toBeVisible();
  // Choosing a language is that control's own touch: it starts nothing, here either.
  await page.getByTestId("lang-zh").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  await expect(cover).toBeVisible();
  await page.getByTestId("lang-en").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  const report = await expectSoundLayout(page, "cover on a very short screen", { fits: false });
  expect(report.scrollY).toBeGreaterThan(0);
  await expectCoverClear(page, "cover on a very short screen");
  // The page itself never scrolls (Safari's toolbars stay put); the booth's own area does.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
    ),
  ).toBe(0);
  await expect(page.getByTestId("scroll-hint")).toBeVisible();
  // The booth's area scrolls down to the cover's last line, as under a finger.
  const scrollToEnd = () =>
    page.evaluate(() => {
      const area = document.querySelector<HTMLElement>("[data-booth-scroll]")!;
      area.scrollTop = area.scrollHeight;
      return area.scrollTop;
    });
  expect(await scrollToEnd()).toBeGreaterThan(0);
  const edition = cover.locator(".journal-cover-edition");
  await expect(edition).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId("sound-toggle")).toBeInViewport({ ratio: 1 });

  // A new screen starts at its top, whatever the last one was scrolled to. A touch on the
  // cover's paper (here its last line, scrolled to) opens the picker.
  const line = (await edition.boundingBox())!;
  await page.mouse.click(line.x + line.width / 2, line.y + line.height / 2);
  await expect(page.getByTestId("screen-pick")).toBeVisible();
  expect(await page.evaluate(() => document.querySelector("[data-booth-scroll]")!.scrollTop)).toBe(
    0,
  );
  await expect(page.getByRole("heading", { name: KIOSK_COPY.en.frame.pickTitle })).toBeVisible();
  // A tap on a card is its options; "이대로 찍기" is the camera.
  await page.getByTestId("frame-option-polaroid1").click();
  await expect(page.getByTestId("screen-options")).toBeVisible();
  await page.getByTestId("confirm-options").click();
  await expect(page.getByTestId("screen-shooting")).toBeVisible();
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
    // Past the first moment of the cover itself.
    await page.waitForTimeout(500);

    // Two taps: the first opens the journal on the frame picker, the second lands on a card
    // that has just appeared there. A tap on a card goes on with it (2026-11-27), so this second
    // tap must not have chosen a frame: the picker waits 800 ms for it (PICK_TAP_GUARD_MS).
    await start.tap();
    await expect(page.getByTestId("screen-pick")).toBeVisible();
    const card = (await page.getByTestId("frame-option-check2").boundingBox())!;
    await page.touchscreen.tap(card.x + card.width / 2, card.y + card.height / 2);
    await page.waitForTimeout(200);
    await expect(page.getByTestId("screen-pick")).toBeVisible();
    await expect(page.locator("main")).toHaveAttribute("data-phase", "pick");
    // Not even marked: the stray tap did nothing at all.
    await expect(page.getByTestId("frame-option-film")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("frame-option-check2")).toHaveAttribute("aria-pressed", "false");

    // A moment later the same tap is a deliberate one: that card, and on to its options.
    await page.waitForTimeout(800);
    await page.touchscreen.tap(card.x + card.width / 2, card.y + card.height / 2);
    await expect(page.getByTestId("screen-options")).toBeVisible();
    await expect(page.getByTestId("confirm-options")).toHaveAttribute("data-frame", /^check2/);
  });
});

test.describe("cover first tap", () => {
  test.use({ hasTouch: true });

  test("tap on the paper or the main button opens the frame picker without a startup delay, and a tap on the cover's own controls does not", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto("/kiosk?camera=mock");
    await expect(page.getByTestId("screen-attract")).toBeVisible();

    // No artificial 500 ms pause: an intentional first tap should always work.
    await page.getByTestId("attract-start").tap();
    await expect(page.getByTestId("screen-pick")).toBeVisible();

    await page.reload();
    const cover = page.getByTestId("screen-attract");
    await expect(cover).toBeVisible();
    // The language, the sound switch: finger taps on them are theirs, and start nothing.
    await page.getByTestId("lang-en").tap();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    const sound = page.getByTestId("sound-toggle");
    const wasOn = await sound.getAttribute("aria-pressed");
    await sound.tap();
    await expect(sound).not.toHaveAttribute("aria-pressed", wasOn!);
    await page.waitForTimeout(200);
    await expect(cover).toBeVisible();
    await expect(page.locator("main")).toHaveAttribute("data-phase", "attract");
    // The paper itself (here: the lockup, far from every control) is the start.
    const lockup = (await cover.locator(".attract-lockup").boundingBox())!;
    await page.touchscreen.tap(lockup.x + lockup.width / 2, lockup.y + lockup.height / 2);
    await expect(page.getByTestId("screen-pick")).toBeVisible();
    await expect(page.getByText("Pick a frame")).toBeVisible();
  });
});
