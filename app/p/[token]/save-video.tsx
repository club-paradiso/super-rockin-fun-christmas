"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

const noSubscribe = () => () => {};
const VIDEO_CHECK_INTERVAL_MS = 3_000;
const VIDEO_CHECK_ATTEMPTS = 20;

/**
 * Guest's silent shoot reel, on the same QR link as the framed photo.
 *
 * The photo and QR may be ready before the video finishes encoding/uploading, especially when
 * the hub is syncing to the cloud. Check the private guest endpoint until the video arrives:
 * a guest who opens the QR straight away must not have to refresh the whole page.
 *
 * Only the presence of actual stored video bytes unlocks the download. Unsupported recorders,
 * failed uploads and older photo-only sessions never show a broken download button.
 */
export function SaveVideo({
  videoUrl,
  initialMime,
}: {
  videoUrl: string;
  initialMime: string | null;
}) {
  const shareApi = useSyncExternalStore(
    noSubscribe,
    () => typeof navigator.canShare === "function" && typeof navigator.share === "function",
    () => false,
  );
  const [mime, setMime] = useState<string | null>(initialMime);
  const [checking, setChecking] = useState(!initialMime);
  const [retry, setRetry] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (initialMime) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    async function check() {
      try {
        const response = await fetch(videoUrl, { method: "HEAD", cache: "no-store" });
        if (cancelled) return;
        const type = response.headers.get("content-type")?.split(";")[0]?.trim();
        if (response.ok && (type === "video/mp4" || type === "video/webm")) {
          setMime(type);
          setChecking(false);
          return;
        }
      } catch {
        // Offline or temporary server errors must not interrupt access to the photo.
      }
      if (cancelled) return;
      attempts += 1;
      if (attempts < VIDEO_CHECK_ATTEMPTS) {
        timer = setTimeout(() => void check(), VIDEO_CHECK_INTERVAL_MS);
      } else {
        setChecking(false);
      }
    }

    void check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [initialMime, videoUrl, retry]);

  // Preload for iOS: navigator.share({ files }) must be called directly from a tap.
  useEffect(() => {
    if (!shareApi || !mime) return;
    let cancelled = false;
    fetch(videoUrl, { cache: "no-store" })
      .then((response) =>
        response.ok ? response.blob() : Promise.reject(new Error(String(response.status))),
      )
      .then((blob) => {
        const next = new File(
          [blob],
          "studio-shalom." + (mime === "video/mp4" ? "mp4" : "webm"),
          { type: mime },
        );
        if (!cancelled && navigator.canShare({ files: [next] })) setFile(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [shareApi, videoUrl, mime]);

  const downloadHref = videoUrl + "?download=1";

  async function save(event: React.MouseEvent<HTMLAnchorElement>) {
    if (!file) return; // Native download is always the fallback.
    event.preventDefault();
    try {
      await navigator.share({ files: [file] });
      setNotice(null);
    } catch (err) {
      if ((err as Error).name !== "AbortError")
        setNotice("저장이 안 되면 아래 ‘파일로 받기’를 눌러 주세요.");
      setFile(null);
    }
  }

  return (
    <section className="flex w-full flex-col items-center gap-3" data-testid="video-save">
      <h2 className="text-lg font-semibold text-ink">촬영 영상</h2>
      {mime ? (
        <>
          <video
            src={videoUrl}
            controls
            playsInline
            preload="metadata"
            className="w-full rounded-lg bg-black"
            aria-label="촬영 영상 미리보기"
            data-testid="video-preview"
          />
          <a
            href={downloadHref}
            download
            onClick={save}
            className="btn-secondary w-full text-center"
            data-testid="video-download-button"
          >
            영상 저장
          </a>
          {file && (
            <p className="text-center text-sm text-ink/75">
              아이폰은 공유 메뉴에서 ‘비디오 저장’을 선택하세요.
            </p>
          )}
          <a
            href={downloadHref}
            download
            className="btn-quiet"
            data-testid="video-file-download"
          >
            파일로 받기
          </a>
          <p className="text-center text-sm text-ink/75">
            촬영하는 모습을 담은 짧은 영상이에요. 소리는 없어요.
          </p>
          {notice && <p className="text-center text-sm text-ink">{notice}</p>}
        </>
      ) : (
        <>
          <p className="text-center text-sm text-ink/75" role="status" data-testid="video-status">
            {checking
              ? "영상을 확인하고 있어요. 준비되면 저장 버튼이 자동으로 나타나요."
              : "촬영 영상이 도착하지 않았어요. 기기에서 영상 촬영을 지원하지 않거나 전송이 완료되지 않았을 수 있어요."}
          </p>
          {!checking && (
            <button
              type="button"
              className="btn-quiet"
              onClick={() => {
                setChecking(true);
                setRetry((value) => value + 1);
              }}
              data-testid="video-retry"
            >
              영상 다시 확인
            </button>
          )}
        </>
      )}
    </section>
  );
}
