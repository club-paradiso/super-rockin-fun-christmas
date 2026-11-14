"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { postJson } from "@/components/admin/api";

/**
 * Shared administrator login (D84): one field, one button. The password is the kiosk enrollment
 * password; it goes to the server once and is never kept in the browser (no storage, and the
 * field is cleared after every attempt).
 */
export function PasswordLoginForm() {
  const router = useRouter();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setMessage(null);
    const res = await postJson("/api/admin/auth/password", { password }, { redirectOn401: false });
    if (res.ok) {
      setPassword("");
      router.replace("/admin");
      router.refresh();
      return;
    }
    setBusy(false);
    setPassword("");
    setMessage(
      res.status === 429
        ? "시도가 너무 많아요. 15분 뒤에 다시 시도해 주세요."
        : res.status === 401
          ? "비밀번호가 맞지 않아요."
          : res.status === 0
            ? "서버에 연결하지 못했어요. 인터넷을 확인해 주세요."
            : "로그인하지 못했어요. 잠시 후 다시 시도해 주세요.",
    );
    input.current?.focus();
  }

  return (
    <form onSubmit={submit} className="mt-6 flex flex-col gap-4" data-testid="login-password-form">
      <div className="flex flex-col gap-2">
        <label htmlFor={id} className="text-lg text-ink">
          비밀번호
        </label>
        <div className="relative">
          <input
            id={id}
            ref={input}
            type={visible ? "text" : "password"}
            name="password"
            required
            autoFocus
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby={message ? `${id}-error` : undefined}
            aria-invalid={message ? true : undefined}
            className="admin-input w-full pr-24"
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-pressed={visible}
            aria-label={visible ? "비밀번호 숨기기" : "비밀번호 보기"}
            data-testid="password-toggle"
            className="absolute inset-y-1 right-1 inline-flex min-w-20 items-center justify-center rounded-md px-3 text-base font-semibold text-ink active:bg-ink/10"
          >
            {visible ? "숨기기" : "보기"}
          </button>
        </div>
      </div>
      {message && (
        <p
          id={`${id}-error`}
          role="alert"
          className="text-lg text-danger"
          data-testid="login-error"
        >
          {message}
        </p>
      )}
      <button type="submit" disabled={busy || !password} className="admin-btn admin-btn-primary">
        {busy ? "여는 중…" : "관리자 화면 열기"}
      </button>
    </form>
  );
}
