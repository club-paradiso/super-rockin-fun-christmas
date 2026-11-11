#!/usr/bin/env node
/**
 * Start the on-site hub and the booth screen (desktop icon "허브와 부스 시작", RUNBOOK 1).
 *
 *   node scripts/hub-start.mjs [--port 3000] [--no-browser]
 *
 * - Builds once if there is no production build yet.
 * - Runs `next start` on all network interfaces and restarts it if it stops (1 s, 2 s, 5 s, 10 s,
 *   then every 30 s; a run that lasted 2 minutes resets the delay). No pm2 or Windows service:
 *   a borrowed laptop may not allow installing either (docs/ARCHITECTURE.md 1.3).
 * - Prints the hub address for staff phones and the wall PC.
 * - Opens the booth in Chrome or Edge, full screen, with its own profile so the camera
 *   permission and the offline queue (IndexedDB) survive restarts.
 *
 * Settings come from .env.local next to package.json (FTL_ROLE=hub ...). See .env.example.
 * Closing this window stops the hub.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const STABLE_MS = 120_000;

/** Delay before restart number `failures` (1-based). */
export function restartDelay(failures) {
  return DELAYS_MS[Math.min(Math.max(failures, 1), DELAYS_MS.length) - 1];
}

/** IPv4 LAN addresses staff phones and the wall can use (no loopback, no link-local). */
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(interfaces))
    for (const a of list ?? [])
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254."))
        out.push(a.address);
  return out;
}

/** Chrome or Edge executables to try, most preferred first. */
export function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
    return [
      ...roots.map((r) => path.win32.join(r, "Google", "Chrome", "Application", "chrome.exe")),
      ...roots.map((r) => path.win32.join(r, "Microsoft", "Edge", "Application", "msedge.exe")),
    ];
  }
  if (platform === "darwin")
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  return ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}

/** Full-screen app window with its own profile directory. */
export function kioskArgs(url, profileDir) {
  return [
    `--user-data-dir=${profileDir}`,
    "--kiosk",
    `--app=${url}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--disable-features=Translate",
    "--autoplay-policy=no-user-gesture-required",
  ];
}

/** KEY=VALUE lines of a dotenv file (no expansion; quotes stripped). */
export function readEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

function parseArgs(argv) {
  const port = Number(argv[argv.indexOf("--port") + 1]);
  return {
    port: argv.includes("--port") && Number.isInteger(port) ? port : 3000,
    browser: !argv.includes("--no-browser"),
  };
}

function say(lines) {
  const bar = "=".repeat(64);
  console.log(`\n${bar}\n${lines.join("\n")}\n${bar}\n`);
}

async function isUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/kiosk/enroll`, { redirect: "manual" });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function waitUntilUp(port, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await isUp(port)) return true;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

function openBooth(port) {
  const exe = browserCandidates().find((p) => existsSync(p));
  if (!exe) {
    say([
      "Chrome 또는 Edge를 찾지 못했어요.",
      `브라우저에서 http://localhost:${port}/kiosk 를 직접 열고 F11로 전체화면을 켜 주세요.`,
    ]);
    return;
  }
  const profile = path.join(ROOT, ".browser", "booth");
  const child = spawn(exe, kioskArgs(`http://localhost:${port}/kiosk`, profile), {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function main() {
  const { port, browser } = parseArgs(process.argv.slice(2));
  process.chdir(ROOT);

  // Double-clicked twice: a second hub would only fail on the busy port and loop.
  if (await isUp(port)) {
    say(["허브는 이미 켜져 있어요. 부스 화면만 다시 띄웁니다."]);
    if (browser) openBooth(port);
    return;
  }

  const env = readEnvFile(path.join(ROOT, ".env.local"));
  if ((process.env.FTL_ROLE ?? env.FTL_ROLE) !== "hub")
    say([
      "경고: .env.local 에 FTL_ROLE=hub 가 없어요.",
      "기술 담당이 .env.example 을 보고 .env.local 을 만들어야 해요.",
    ]);

  const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(nextBin)) {
    say(["프로그램 설치가 안 되어 있어요. 기술 담당이 `npm ci` 를 먼저 실행해야 해요."]);
    process.exit(1);
  }
  if (!existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
    say(["처음 실행이라 준비하는 중이에요 (몇 분 걸려요)..."]);
    const built = spawnSync(process.execPath, [nextBin, "build"], { stdio: "inherit" });
    if (built.status !== 0) process.exit(built.status ?? 1);
  }

  let stopping = false;
  let child = null;
  for (const sig of ["SIGINT", "SIGTERM"])
    process.on(sig, () => {
      stopping = true;
      child?.kill(sig);
    });

  let failures = 0;
  let opened = false;
  while (!stopping) {
    const startedAt = Date.now();
    child = spawn(process.execPath, [nextBin, "start", "-H", "0.0.0.0", "-p", String(port)], {
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "production" },
    });
    const exited = new Promise((resolve) =>
      child.on("exit", (code, signal) => resolve(signal ?? `코드 ${code}`)),
    );

    if (await Promise.race([waitUntilUp(port), exited.then(() => false)])) {
      failures = 0;
      const lan = lanAddresses();
      say([
        "STUDIO SHALOM 허브가 켜졌어요. 이 창은 닫지 마세요 (최소화는 괜찮아요).",
        "",
        "스태프 휴대폰 (관리자):",
        ...(lan.length
          ? lan.map((a) => `    http://${a}:${port}/admin`)
          : ["    (공유기에 연결되지 않았어요. 와이파이·랜선을 확인하세요)"]),
        "미디어월 PC:",
        ...lan.map((a) => `    http://${a}:${port}/wall`),
        "이 노트북 (부스):",
        `    http://localhost:${port}/kiosk`,
      ]);
      if (browser && !opened) {
        opened = true;
        openBooth(port);
      }
    }

    const why = await exited;
    if (stopping) break;
    if (Date.now() - startedAt > STABLE_MS) failures = 0;
    failures++;
    const delay = restartDelay(failures);
    say([`허브가 멈췄어요 (${why}). ${Math.round(delay / 1000)}초 뒤 다시 켭니다.`]);
    await new Promise((r) => setTimeout(r, delay));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
