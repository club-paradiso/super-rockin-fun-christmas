/**
 * Recommended poses for the pose guide (D71), one per shot, in shooting order. Text only: there
 * are no pose illustrations. The sequence repeats so every pose gets two tries.
 * Its length must equal KIOSK_CONFIG.shotsPerSession (tests/unit/poses.test.ts).
 */
export interface Pose {
  id: string;
  /** Short Korean label shown during the countdown. */
  label: string;
  /** The same label on the English booth screens (D78). Falls back to `label`. */
  labelEn?: string;
  /** The same label on the Chinese booth screens (D89). Falls back to `label`. */
  labelZh?: string;
}

const FACE = {
  id: "face-each-other",
  label: "서로 마주 보기",
  labelEn: "Face each other",
  labelZh: "面对面",
} as const;
const SHOULDERS = {
  id: "arms-on-shoulders",
  label: "어깨동무",
  labelEn: "Arms around shoulders",
  labelZh: "搭肩",
} as const;
const HANDSHAKE = {
  id: "handshake",
  label: "악수하기",
  labelEn: "Shake hands",
  labelZh: "握手",
} as const;

export const POSE_SEQUENCE: readonly Pose[] = [
  FACE,
  SHOULDERS,
  HANDSHAKE,
  FACE,
  SHOULDERS,
  HANDSHAKE,
];
