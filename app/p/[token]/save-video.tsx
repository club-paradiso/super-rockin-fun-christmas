"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

/**
 * "영상 저장" (D72): the silent video of the shoot, next to the photo. Shown only when the server
 * really has a video for this link. Works like SavePhoto: the share sheet where the phone can
 * share files (iPhone: "비디오 저장"), otherwise a normal file download. Secondary on purpose —
 * the photo stays the one primary action on the page.
 */
export function SaveVideo({ videoUrl, mime }: { videoUrl: string; mime: string }) {
  const shareApi = useSyncExternalStore(
    noSubscribe,
    () => typeof navigator.canShare === "function" && typeof navigator.share === "function",
    () => false,
  );
  // Fetched ahead of time: Safari only allows share() right after the tap.
  const [file, setFile] = useState<File | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!shareApi) return;
    let cancelled = false;
    fetch(videoUrl)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((blob) => {
        const f = new File([blob], `studio-shalom.${mime === "video/mp4" ? "mp4" : "webm"}`, {
          type: mime,
        });
        if (!cancelled && navigator.canShare({ files: [f] })) setFile(f);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [shareApi, videoUrl, mime]);

  const downloadHref = `${videoUrl}?download=1`;

  async function save(event: React.MouseEvent<HTMLAnchorElement>) {
    if (!file) return; // fall through to the plain download link
    event.preventDefault();
    try {
      await navigator.share({ files: [file] });
      setNotice(null);
    } catch (err) {
      if ((err as Error).name !== "AbortError")
        setNotice("저장이 안 되면 한 번 더 눌러 파일로 받아 주세요.");
      setFile(null); // the next tap is a plain download
    }
  }

  return (
    <div className="flex w-full flex-col items-center gap-2" data-testid="video-save">
      <a
        href={downloadHref}
        download
        onClick={save}
        className="btn-secondary w-full text-center"
        data-testid="video-download-button"
      >
        영상 저장
      </a>
      <p className="text-center text-sm text-ink/75">
        촬영하는 모습을 담은 짧은 영상이에요. 소리는 없어요.
      </p>
      {notice && <p className="text-center text-sm text-ink">{notice}</p>}
    </div>
  );
}
