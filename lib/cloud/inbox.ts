import { isMobileFrameId, MOBILE_FRAME_ID } from "@/config/mobile";
import { hasImageSignature } from "@/lib/server/request";
import type { PhotoService } from "@/lib/storage/photo-service";
import type { StorageBackend } from "@/lib/storage/types";
import type { CloudInboxClient } from "./client";

export interface HubInboxStatus {
  /** When the hub last reached the cloud inbox successfully (null = never since start). */
  lastPullAt: string | null;
  lastError: string | null;
  /** Phone photos taken in since the hub started. */
  imported: number;
}

/**
 * The hub's side of phone uploads (D66). Phone photos arrive in the cloud (guests' phones are on
 * cellular data, not on the event LAN); the hub takes each one, stores it as its own photo
 * (PENDING, with the guest's consent), then acknowledges so the cloud deletes its copy. From then
 * on the hub is the only record: moderation, the wall and deletion happen here, as for booth
 * photos.
 *
 * Crash-safe and idempotent: storing is keyed by the QR session id, so a photo taken in twice is
 * one photo; the cloud copy is deleted only after the hub has stored it (or already deleted it
 * here, in which case it must not come back). Offline, nothing happens and nothing is lost: the
 * photos wait in the cloud, and none of them is shown anywhere until staff approve it on the hub.
 */
export class HubInbox {
  private running: Promise<void> | null = null;
  private readonly state: HubInboxStatus = { lastPullAt: null, lastError: null, imported: 0 };

  constructor(
    private readonly service: PhotoService,
    private readonly backend: StorageBackend,
    private readonly client: CloudInboxClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  status(): HubInboxStatus {
    return { ...this.state };
  }

  /** One pass over the cloud inbox. Concurrent callers share the pass in flight. */
  pull(): Promise<void> {
    this.running ??= this.pass().finally(() => (this.running = null));
    return this.running;
  }

  private fail(message: string) {
    this.state.lastError = message;
  }

  private async pass() {
    const list = await this.client.inbox();
    if (!list.ok) return this.fail(list.message);
    this.state.lastPullAt = this.now().toISOString();
    this.state.lastError = null;
    for (const item of list.value) {
      const done = await this.takeOne(item.sessionId, item.frameId);
      // Still failing: the cloud is probably unreachable; the next pass tries again.
      if (!done) break;
    }
  }

  /** True when this item is finished (stored and acknowledged), false to stop the pass. */
  private async takeOne(sessionId: string, cloudFrameId: string | undefined): Promise<boolean> {
    const existing = await this.backend.photos.findBySessionId(sessionId);
    if (existing) {
      // Taken in before, but maybe only half (the hub stopped between storing the row and
      // recording the guest's consent): finish it before the cloud copy is let go. A photo
      // deleted here stays deleted.
      await this.service.completeMobile(sessionId, null);
    } else {
      const image = await this.client.inboxImage(sessionId);
      if (!image.ok) {
        if (image.gone) return true; // deleted in the cloud meanwhile: nothing to take
        this.fail(image.message);
        return false;
      }
      if (!hasImageSignature(image.value, "image/jpeg")) {
        // The cloud only stores JPEGs it encoded itself; anything else is not taken in.
        this.fail("cloud inbox image is not a JPEG");
        return true;
      }
      const stored = await this.service.putMobile({
        sessionId,
        kioskId: null,
        data: image.value,
        // The guest uploaded through a QR the hub issued; review still decides.
        submissionsPaused: false,
        // The frame the guest chose (D89). A frame this hub does not know (a cloud deployed
        // ahead of it) is stored as a plain phone photo: the picture itself already has it.
        frameId: cloudFrameId && isMobileFrameId(cloudFrameId) ? cloudFrameId : MOBILE_FRAME_ID,
      });
      if (stored.ok && !stored.duplicate) this.state.imported++;
    }
    // Stored here (or deleted here already): the cloud copy can go.
    const ack = await this.client.ack(sessionId);
    if (!ack.ok && ack.retry) {
      this.fail(ack.message);
      return false;
    }
    return true;
  }
}
