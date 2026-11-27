"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { loadImage } from "@/components/studio/stamp-ticket";
import { canvasToBlob, createDomCanvas } from "@/lib/canvas";
import { KIOSK_COPY } from "@/lib/kiosk/copy";
import { drawStoryImage, storyFileName, storyFontRequest } from "@/lib/studio/story";

const noSubscribe = () => () => {};

/**
 * "인스타 스토리용으로 저장": the framed photo on a 1080 × 1920 (9:16) picture, drawn on the phone
 * from the page's own image and kept on the phone. The share sheet where there is one (iPhone and
 * Android list Instagram there, and "이미지 저장"), a download otherwise. If it cannot be drawn,
 * the button is not shown; the ordinary save above it is untouched.
 */
export function SaveStory({ imageUrl, createdAt }: { imageUrl: string; createdAt: string }) {
  const shareApi = useSyncExternalStore(
    noSubscribe,
    () => typeof navigator.canShare === "function" && typeof navigator.share === "function",
    () => false,
  );
  const [file, setFile] = useState<File | null>(null);
  const [failed, setFailed] = useState(false);

  // Drawn ahead of the tap: Safari only allows share() right after a touch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const event = KIOSK_COPY.ko.attract.event;
        if (typeof document !== "undefined" && document.fonts) {
          const font = storyFontRequest(event);
          await document.fonts.load(font.spec, font.text).catch(() => []);
        }
        const image = await loadImage(imageUrl);
        if (!image || !image.naturalWidth || !image.naturalHeight) throw new Error("no image");
        const canvas = drawStoryImage(
          createDomCanvas,
          { image, width: image.naturalWidth, height: image.naturalHeight },
          event,
        );
        const blob = await canvasToBlob(canvas as HTMLCanvasElement, "image/jpeg", 0.92);
        if (!cancelled) setFile(new File([blob], storyFileName(createdAt), { type: "image/jpeg" }));
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [imageUrl, createdAt]);

  async function save() {
    if (!file) return;
    if (shareApi && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
      }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  if (failed) return null;
  return (
    <div className="flex w-full flex-col items-center gap-2">
      <button
        type="button"
        className="btn-secondary w-full"
        data-testid="save-story"
        data-ready={file ? "true" : "false"}
        disabled={!file}
        onClick={() => void save()}
      >
        인스타 스토리용으로 저장
      </button>
      <p className="text-center text-sm text-ink/75 [word-break:keep-all]">
        스토리 크기(9:16)에 맞춘 사진이에요. 공유 메뉴에서 인스타그램을 고르면 바로 올릴 수 있어요.
      </p>
    </div>
  );
}
