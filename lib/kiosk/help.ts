/**
 * Staff help mode on the booth (docs/ARCHITECTURE.md 1.9): hold a corner, pick your name, type
 * your PIN, then a small menu of things the booth does to itself. Pure; the panel component runs
 * the effects (fetching names, checking the PIN on the hub) and dispatches.
 *
 *   closed ─OPEN─► pick ─PICK─► pin ─UNLOCKED─► menu
 *     ▲              ▲  └BACK──┘ └DENIED (stays, shows why)
 *     └──────── CLOSE / IDLE from anywhere ─────────┘
 */
export interface HelpStaff {
  userId: string;
  displayName: string;
}

export type HelpDenial = "wrong" | "locked" | "offline";

export type HelpState =
  | { step: "closed" }
  | { step: "pick"; staff: HelpStaff[] | null; failed: boolean }
  | {
      step: "pin";
      staff: HelpStaff[];
      who: HelpStaff;
      pin: string;
      checking: boolean;
      denied: HelpDenial | null;
    }
  | { step: "menu"; displayName: string };

export type HelpAction =
  | { type: "OPEN" }
  | { type: "STAFF_LOADED"; staff: HelpStaff[] }
  | { type: "STAFF_FAILED" }
  | { type: "PICK"; userId: string }
  | { type: "BACK" }
  | { type: "PIN"; pin: string }
  | { type: "CHECKING" }
  | { type: "UNLOCKED"; displayName: string }
  | { type: "DENIED"; reason: HelpDenial }
  | { type: "CLOSE" };

export const HELP_PIN_LENGTH = 6;
export const HELP_CLOSED: HelpState = { step: "closed" };

export function helpReducer(state: HelpState, action: HelpAction): HelpState {
  switch (action.type) {
    case "OPEN":
      return state.step === "closed" ? { step: "pick", staff: null, failed: false } : state;
    case "STAFF_LOADED":
      return state.step === "pick" ? { ...state, staff: action.staff, failed: false } : state;
    case "STAFF_FAILED":
      return state.step === "pick" ? { ...state, failed: true } : state;
    case "PICK": {
      if (state.step !== "pick" || !state.staff) return state;
      const who = state.staff.find((s) => s.userId === action.userId);
      return who
        ? { step: "pin", staff: state.staff, who, pin: "", checking: false, denied: null }
        : state;
    }
    case "BACK":
      return state.step === "pin" ? { step: "pick", staff: state.staff, failed: false } : state;
    case "PIN":
      return state.step === "pin" && !state.checking
        ? { ...state, pin: action.pin.replace(/\D/g, "").slice(0, HELP_PIN_LENGTH) }
        : state;
    case "CHECKING":
      return state.step === "pin" && state.pin.length === HELP_PIN_LENGTH
        ? { ...state, checking: true, denied: null }
        : state;
    case "UNLOCKED":
      return state.step === "pin" && state.checking
        ? { step: "menu", displayName: action.displayName }
        : state;
    case "DENIED":
      // The PIN is cleared so the next try starts fresh; it is never kept around.
      return state.step === "pin"
        ? { ...state, checking: false, pin: "", denied: action.reason }
        : state;
    case "CLOSE":
      return HELP_CLOSED;
  }
}
