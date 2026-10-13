import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { MEASURE_OUT, MEASURE_PIN, MEASURE_SETUP_CODE } from "./env";

/**
 * Is the wall renderer's memory growth a leak or a cache? Runs the wall at 3840×1080 for
 * PROBE_MINUTES (default 20), sampling the renderer's resident memory, then asks Chromium to
 * free memory as if the machine were short of it. Memory that comes back was cache.
 *
 *   MEASURE_PORT=3400 MEASURE_PHOTOS=300 npx playwright test -c playwright.measure.config.ts \
 *     measure/probe.measure.ts
 */
const MINUTES = Number(process.env.PROBE_MINUTES ?? 20);

async function rendererRssMb(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    const cmd = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    if (!cmd.includes("--type=renderer")) continue;
    const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
    const kb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1]);
    if (kb) out[pid] = Math.round(kb / 1024);
  }
  return out;
}

async function typePin(page: Page, pin: string) {
  for (const d of pin) await page.getByRole("button", { name: d, exact: true }).click();
}

test("probe: wall renderer memory, then a memory-pressure purge", async ({ browser }) => {
  const staff = await (await browser.newContext()).newPage();
  await staff.goto("/admin/login");
  await staff.getByLabel("설정 코드").fill(MEASURE_SETUP_CODE);
  await staff.getByLabel("이름").fill("측정");
  await typePin(staff, MEASURE_PIN);
  await staff.getByRole("button", { name: "첫 스태프 만들기" }).click();
  await expect(staff).toHaveURL(/\/admin$/);
  await staff.goto("/admin/kiosks");
  await staff.getByLabel("새 키오스크 이름").fill("probe wall");
  await staff.getByTestId("create-enrollment-code").click();
  const code = (await staff.getByTestId("enrollment-code").textContent())!.trim();
  await staff.close();

  const ctx = await browser.newContext({ viewport: { width: 3840, height: 1080 } });
  const wall = await ctx.newPage();
  await wall.goto("/kiosk/enroll?next=wall");
  await wall.getByLabel("등록 코드").fill(code);
  await wall.getByRole("button", { name: "이 기기 등록" }).click();
  await expect(wall).toHaveURL(/\/wall$/);
  const before = await rendererRssMb();
  await wall.goto("/wall?canvas=3840x1080");
  await expect(wall.getByTestId("wall-photo").first()).toBeVisible({ timeout: 60_000 });
  // The wall's renderer: the one that grew most since before the wall opened.
  const pick = (now: Record<string, number>) =>
    Object.entries(now).sort(
      (a, b) => b[1] - (before[b[0]] ?? 0) - (a[1] - (before[a[0]] ?? 0)),
    )[0]!;
  const [pid] = pick(await rendererRssMb());
  const cdp = await ctx.newCDPSession(wall);
  const samples: { minute: number; rssMb: number }[] = [];
  for (let m = 0; m <= MINUTES; m++) {
    samples.push({ minute: m, rssMb: (await rendererRssMb())[pid] ?? -1 });
    if (m < MINUTES) await wall.waitForTimeout(60_000);
  }
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("Memory.simulatePressureNotification", { level: "critical" });
  await wall.waitForTimeout(15_000);
  const afterPurge = (await rendererRssMb())[pid] ?? -1;
  await wall.waitForTimeout(120_000);
  const twoMinLater = (await rendererRssMb())[pid] ?? -1;
  const result = { minutes: MINUTES, pid, samples, afterPurge, twoMinLater };
  await mkdir(MEASURE_OUT, { recursive: true });
  await writeFile(path.join(MEASURE_OUT, "probe.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
});
