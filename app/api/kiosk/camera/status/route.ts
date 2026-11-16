import { NextResponse } from "next/server";
import { RateLimiter } from "@/lib/server/rate-limit";
import { kioskCameraRoute, pairingStatus } from "@/lib/remote-camera/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = new RateLimiter(240, 60_000);

/** Booth → is a camera paired to me, and is it online? (A yes/no, never a picture.) */
export const GET = kioskCameraRoute("kiosk_camera_status", limiter, async (_request, ctx) =>
  NextResponse.json(pairingStatus(ctx.pairing, Date.now()), { headers: ctx.headers }),
);
