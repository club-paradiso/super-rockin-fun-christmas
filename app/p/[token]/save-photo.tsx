"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

/**
 * One big "save" action that does the best thing the phone allows:
 *  - Web Share with files (iOS Safari, Android Chrome): opens the share sheet, where iPhone shows
 *    "이미지 저장" (save to Photos). JavaScript cannot save to the Photos library by itself.
 *  - Otherwise a normal file download (Android saves to Downloads/Gallery; iOS to Files).
 * The image itself also supports long-press → "사진 앱에 저장" on iPhone.
 */
export function SavePhoto({ imageUrl, mime }: { imageUrl: string; mime: string }) {
  const shareApi = useSyncExternalStore(
    noSubscribe,
    () => typeof navigator.canShare === "function" && typeof navigator.share === "function",
    () => false,
  );
  // Fetch ahead of time: Safari only allows share() right after the tap, so the file must be
  // ready before the guest presses the button.
  const [file, setFile] = useState<File | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!shareApi) return;
    let cancelled = false;
    fetch(imageUrl)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((blob) => {
        const f = new File([blob], `follow-the-lights.${mime === "image/png" ? "png" : "jpg"}`, {
          type: blob.type || mime,
        });
        if (!cancelled && navigator.canShare({ files: [f] })) setFile(f);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [shareApi, imageUrl, mime]);

  const downloadHref = `${imageUrl}?download=1`;

  async function save(event: React.MouseEvent<HTMLAnchorElement>) {
    if (!file) return; // fall through to the plain download link
    event.preventDefault();
    try {
      await navigator.share({ files: [file] });
      setNotice(null);
    } catch (err) {
      if ((err as Error).name !== "AbortError")
        setNotice("저장이 안 되면 아래 ‘파일로 받기’를 눌러 주세요.");
    }
  }

  return (
    <div className="flex w-full flex-col items-center gap-3">
      <a
        href={downloadHref}
        download
        onClick={save}
        className="btn-primary w-full text-center"
        data-testid="download-button"
      >
        사진 저장하기
      </a>
      {file && (
        <p className="text-center text-sm text-mist" data-testid="share-hint">
          아이폰은 공유 메뉴에서 ‘이미지 저장’을 누르세요.
        </p>
      )}
      {notice && <p className="text-center text-sm text-amber">{notice}</p>}
      <a href={downloadHref} download className="btn-quiet" data-testid="file-download">
        파일로 받기
      </a>
      <p className="text-center text-sm text-mist">
        사진을 길게 눌러 ‘사진 앱에 저장’도 할 수 있어요.
      </p>
    </div>
  );
}
