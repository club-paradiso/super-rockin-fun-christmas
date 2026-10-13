"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "./api";

/** "지금 백업": copies the hub to the USB stick now (also runs by itself every few minutes). */
export function BackupButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="admin-btn-primary"
        data-testid="backup-now"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMessage(null);
          const res = await postJson<{ files: number }>("/api/admin/backup", {});
          setBusy(false);
          if (res.ok) setMessage(`백업했어요 (사진 파일 ${res.data.files}개).`);
          else setMessage("백업하지 못했어요. USB가 꽂혀 있는지 확인해 주세요.");
          router.refresh();
        }}
      >
        {busy ? "백업하는 중…" : "지금 백업"}
      </button>
      {message && (
        <p className="text-base" role="status" data-testid="backup-message">
          {message}
        </p>
      )}
    </div>
  );
}
