import type { KioskRow } from "./types";

/** A freshly enrolled kiosk with no heartbeat yet. */
export function newKioskRow(
  id: string,
  label: string,
  enrolledVia: KioskRow["enrolledVia"],
  createdAt = new Date().toISOString(),
): KioskRow {
  return {
    id,
    label,
    createdAt,
    revokedAt: null,
    lastSeenAt: null,
    heartbeatAt: null,
    queueDepth: null,
    cameraState: null,
    appBuild: null,
    enrolledVia,
  };
}
