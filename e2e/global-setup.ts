import { request } from "@playwright/test";
import { ENROLL_SECRET, HUB_CLOUD_PORT, PORT, USE_SUPABASE } from "./env";

/**
 * Runs once, after the servers are up and before any spec.
 *
 * The event starts in AI review (`moderationMode: "auto"`, the default since 2026-11-25), and the
 * E2E servers have the built-in mock provider, which approves every photo. Most specs were written
 * for a person approving: they expect a yes to wait as PENDING. So, on every hub the specs use
 * (the main one and, on hub runs, the hub-with-a-cloud of e2e/cloud.spec.ts), this checks the
 * fresh default first (a failure here means the default changed), then sets manual for the run.
 * `e2e/zz-ai-review.spec.ts` switches auto on for itself and puts manual back.
 *
 * 「내 사진으로 참여하기」 is off by default (2026-11-27, a user decision). Many specs use the cover's
 * phone button, so this checks the fresh default is off, then turns it on for the run;
 * `e2e/mobile.spec.ts` switches it off for itself and checks the button is gone, then back on.
 */
export default async function globalSetup() {
  const ports = USE_SUPABASE ? [PORT] : [PORT, HUB_CLOUD_PORT];
  for (const port of ports) await startInManual(`http://127.0.0.1:${port}`);
}

async function startInManual(baseURL: string) {
  const api = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
  try {
    const login = await api.post("/api/admin/auth/password", { data: { password: ENROLL_SECRET } });
    if (!login.ok())
      throw new Error(`${baseURL}: admin login for E2E setup: HTTP ${login.status()}`);
    const before = (await (await api.get("/api/admin/settings")).json()) as {
      settings: { moderationMode: string; mobileUpload: boolean };
    };
    if (before.settings.mobileUpload !== false)
      throw new Error(`${baseURL}: 「내 사진으로 참여하기」 should start off on a fresh event`);
    const phone = await api.post("/api/admin/settings", { data: { mobileUpload: true } });
    if (!phone.ok())
      throw new Error(`${baseURL}: could not turn the phone way in on: HTTP ${phone.status()}`);
    if (before.settings.moderationMode !== "auto")
      throw new Error(
        `${baseURL}: a fresh event should start in AI review ("auto"), found "${before.settings.moderationMode}"`,
      );
    const res = await api.post("/api/admin/settings", { data: { moderationMode: "manual" } });
    if (!res.ok()) throw new Error(`${baseURL}: could not set manual review: HTTP ${res.status()}`);
  } finally {
    await api.dispose();
  }
}
