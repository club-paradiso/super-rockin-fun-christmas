"use client";

/** JSON POST to a staff API. Same-origin; the HttpOnly session cookie authenticates. */
export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  opts: { redirectOn401?: boolean } = {},
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (res.ok) return { ok: true, data };
    // Session ended (expired / signed out elsewhere): full reload to the login page.
    if (res.status === 401 && opts.redirectOn401 !== false) {
      window.location.replace(new URL("/admin/login", window.location.origin));
    }
    return { ok: false, status: res.status, error: data.error ?? `HTTP ${res.status}` };
  } catch {
    return { ok: false, status: 0, error: "network" };
  }
}

export const ERROR_TEXT: Record<string, string> = {
  invalid_transition: "이미 다른 상태로 바뀌었어요. 새로고침해 주세요.",
  conflict: "다른 스태프가 먼저 처리했어요. 새로고침해 주세요.",
  no_consent: "미디어월 동의가 없는 사진은 승인할 수 없어요.",
  deleted: "이미 삭제된 사진이에요.",
  not_found: "찾을 수 없어요.",
  retention_passed: "보관 기간이 끝나 새 QR을 만들 수 없어요.",
  network: "네트워크 오류예요. 다시 시도해 주세요.",
  not_on_wall: "승인되고 미디어월 동의가 있는 사진만 띄울 수 있어요.",
  not_staff: "스태프 권한이 없어요.",
  inactive: "비활성화된 스태프 계정이에요.",
  "cannot deactivate yourself": "본인 계정은 비활성화할 수 없어요.",
};

export const errorText = (e: string) => ERROR_TEXT[e] ?? `오류: ${e}`;
