"use client";

import { useState, useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

/** Share sheet when the phone supports sharing files (iOS "사진에 저장" lives there). */
export function SaveTips({ imageUrl }: { imageUrl: string }) {
  const canShare = useSyncExternalStore(
    noSubscribe,
    () => typeof navigator.canShare === "function",
    () => false,
  );
  const [busy, setBusy] = useState(false);

  async function share() {
    setBusy(true);
    try {
      const blob = await (await fetch(imageUrl)).blob();
      const ext = blob.type === "image/png" ? "png" : "jpg";
      const file = new File([blob], `follow-the-lights.${ext}`, { type: blob.type });
      if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
    } catch {
      // Guest cancelled the share sheet, or sharing is unsupported. The save button still works.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex w-full flex-col items-center gap-3">
      {canShare && (
        <button type="button" onClick={share} disabled={busy} className="btn-secondary w-full">
          {busy ? "준비 중…" : "공유 · 사진 앱에 저장"}
        </button>
      )}
      <p className="text-center text-sm text-mist">
        저장이 안 되면 사진을 길게 눌러 &lsquo;사진 앱에 저장&rsquo;을 선택하세요.
      </p>
    </div>
  );
}
