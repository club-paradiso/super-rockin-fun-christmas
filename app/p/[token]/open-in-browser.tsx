"use client";

import { useState } from "react";
import { externalBrowserUrl, inAppMenuHint } from "@/lib/guest/save-env";
import { useSaveEnv } from "./use-save-env";

/**
 * Shown only inside an app's own browser (KakaoTalk, NAVER, Instagram …), where saving often
 * does nothing. Offers the real browser and, as a last resort, copying the link.
 */
export function OpenInBrowser() {
  const env = useSaveEnv();
  const [copied, setCopied] = useState(false);
  if (!env.inApp) return null;
  const pageUrl = typeof window === "undefined" ? "" : window.location.href;
  const external = externalBrowserUrl(env, pageUrl);

  async function copy() {
    try {
      await navigator.clipboard.writeText(pageUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section
      className="w-full rounded-lg border-2 border-ink p-4 text-center"
      data-testid="open-in-browser"
      data-in-app={env.inApp}
    >
      <p className="text-base font-bold text-ink [word-break:keep-all]">
        {env.inApp === "kakaotalk" ? "카카오톡" : "이 앱"} 안에서는 저장이 잘 안 될 수 있어요.
      </p>
      <p className="mt-1 text-sm text-ink/75 [word-break:keep-all]">
        {env.os === "android" ? "크롬이나 삼성 인터넷" : "Safari"}에서 열면 바로 저장돼요.
      </p>
      {external && (
        <a href={external} className="btn-secondary mt-3 block w-full" data-testid="open-external">
          {env.os === "android" ? "인터넷 앱으로 열기" : "Safari로 열기"}
        </a>
      )}
      <p className="mt-3 text-sm text-ink/75 [word-break:keep-all]">
        {external ? "안 열리면 " : ""}
        {inAppMenuHint(env)}
      </p>
      <button type="button" className="btn-quiet mt-1" onClick={() => void copy()}>
        {copied ? "주소를 복사했어요" : "주소 복사하기"}
      </button>
    </section>
  );
}
