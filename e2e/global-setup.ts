import { request } from "@playwright/test";
import { ENROLL_SECRET, PORT } from "./env";

/**
 * Runs once, after the servers are up and before any spec.
 *
 * The event starts in AI review (`moderationMode: "auto"`, the default since 2026-11-25), and the
 * E2E servers have the built-in mock provider, which approves every photo. Most specs were written
 * for a person approving: they expect a yes to wait as PENDING. So this checks the fresh default
 * first (a failure here means the default changed), then sets the event to manual for the run.
 * `e2e/zz-ai-review.spec.ts` switches auto on for itself and puts manual back.
 */
export default async function globalSetup() {
  const baseURL = `http://127.0.0.1:${PORT}`;
  const api = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
  try {
    const login = await api.post("/api/admin/auth/password", { data: { password: ENROLL_SECRET } });
    if (!login.ok()) throw new Error(`admin login for E2E setup: HTTP ${login.status()}`);
    const before = (await (await api.get("/api/admin/settings")).json()) as {
      settings: { moderationMode: string };
    };
    if (before.settings.moderationMode !== "auto")
      throw new Error(
        `a fresh event should start in AI review ("auto"), found "${before.settings.moderationMode}"`,
      );
    const res = await api.post("/api/admin/settings", { data: { moderationMode: "manual" } });
    if (!res.ok()) throw new Error(`E2E setup could not set manual review: HTTP ${res.status()}`);
  } finally {
    await api.dispose();
  }
}
