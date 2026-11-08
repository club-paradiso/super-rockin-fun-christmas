import { NextResponse } from "next/server";
import { mintUploadSession } from "@/lib/mobile/server";
import { getServerConfig } from "@/lib/server/env";
import { NO_STORE } from "@/lib/server/http";
import { hubRoute } from "@/lib/server/hub-route";
import { publicOrigin } from "@/lib/server/public-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hub → cloud: a phone-upload QR on this cloud's public address (D66). The photo it brings waits
 * in the inbox until the hub takes it. Writes nothing.
 */
export const POST = hubRoute("hub_upload_session", async (request) => {
  const session = mintUploadSession(publicOrigin(getServerConfig(), request), null);
  return NextResponse.json(session, { headers: NO_STORE });
});
