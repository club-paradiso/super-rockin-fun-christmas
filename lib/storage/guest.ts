import "server-only";
import { logEvent } from "@/lib/server/log";
import { getPhotoService } from "./server";
import type { GuestPhoto } from "./types";

/**
 * The only way guest-facing routes look photos up. Unknown, malformed, expired and deleted all
 * collapse to null so a response never reveals whether a guessed token ever existed.
 */
export async function findGuestPhoto(token: string): Promise<GuestPhoto | null> {
  const result = await getPhotoService().resolve(token);
  if (result.ok) {
    return {
      id: result.row.id,
      mime: result.row.mime,
      bytes: result.row.bytes,
      createdAt: result.row.createdAt,
      tokenExpiresAt: result.row.tokenExpiresAt,
    };
  }
  if (result.reason === "expired" || result.reason === "deleted") {
    logEvent("guest_link_unavailable", { reason: result.reason });
  }
  return null;
}

export async function readGuestImage(
  token: string,
): Promise<{ photo: GuestPhoto; data: Uint8Array } | null> {
  const result = await getPhotoService().read(token);
  if ("data" in result) return result;
  if (!result.ok && (result.reason === "expired" || result.reason === "deleted")) {
    logEvent("guest_image_unavailable", { reason: result.reason });
  }
  return null;
}
