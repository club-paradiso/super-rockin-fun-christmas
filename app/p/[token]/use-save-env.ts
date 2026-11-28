"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_SAVE_ENV, detectSaveEnv, type SaveEnv } from "@/lib/guest/save-env";

const noSubscribe = () => () => {};
let cached: SaveEnv | null = null;

function snapshot(): SaveEnv {
  cached ??= detectSaveEnv(navigator.userAgent, navigator.maxTouchPoints ?? 0);
  return cached;
}

/** The phone's save situation. The server render (and hydration) sees the neutral default. */
export function useSaveEnv(): SaveEnv {
  return useSyncExternalStore(noSubscribe, snapshot, () => DEFAULT_SAVE_ENV);
}
