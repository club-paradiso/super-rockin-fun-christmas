import type { CameraReport } from "./protocol";
import { isOnline, withFreshThumb, type Pairing } from "./store";

/** What /admin may know about a paired camera. No cookie, no code, no mailbox content. */
export interface StaffCameraView {
  id: string;
  kioskId: string;
  kioskLabel: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  /** Derived: a camera not heard from lately is offline whatever it last said. */
  online: boolean;
  report: CameraReport;
}

export function toStaffCameraView(
  p: Pairing,
  kioskLabel: string,
  nowMs = Date.now(),
): StaffCameraView {
  const online = isOnline(p, nowMs);
  const report = withFreshThumb(p.report, nowMs);
  return {
    id: p.id,
    kioskId: p.kioskId,
    kioskLabel,
    name: p.name,
    createdAt: p.createdAt,
    lastSeenAt: p.lastSeenAt,
    revokedAt: p.revokedAt,
    online,
    report: online ? report : { ...report, state: "offline" },
  };
}
