"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/components/admin/api";

/** Email → 6-digit code → session. No passwords, no self-registration. */
export function LoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const res = await postJson("/api/admin/auth/otp", { email }, { redirectOn401: false });
    setBusy(false);
    if (res.ok) setStep("code");
    else
      setMessage(
        res.status === 429
          ? "요청이 너무 많아요. 잠시 후 다시 시도해 주세요."
          : "이메일을 확인해 주세요.",
      );
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const res = await postJson("/api/admin/auth/verify", { email, code }, { redirectOn401: false });
    setBusy(false);
    if (res.ok) {
      router.replace("/admin");
      router.refresh();
      return;
    }
    setMessage(
      res.status === 403
        ? "이 계정은 스태프 권한이 없어요."
        : res.status === 429
          ? "시도가 너무 많아요. 잠시 후 다시 시도해 주세요."
          : "코드가 맞지 않거나 만료됐어요.",
    );
  }

  return step === "email" ? (
    <form onSubmit={sendCode} className="mt-6 flex flex-col gap-4" data-testid="login-email-form">
      <label className="flex flex-col gap-2 text-lg text-ink">
        스태프 이메일
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="admin-input"
        />
      </label>
      {message && <p className="text-lg text-danger">{message}</p>}
      <button type="submit" disabled={busy} className="admin-btn admin-btn-primary">
        {busy ? "보내는 중…" : "로그인 코드 받기"}
      </button>
    </form>
  ) : (
    <form onSubmit={verify} className="mt-6 flex flex-col gap-4" data-testid="login-code-form">
      <p className="text-lg text-ink/75">
        등록된 스태프라면 <strong className="text-ink">{email}</strong>로 6자리 코드를 보냈어요.
      </p>
      <label className="flex flex-col gap-2 text-lg text-ink">
        로그인 코드
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="admin-input text-center text-3xl tracking-[0.4em]"
        />
      </label>
      {message && <p className="text-lg text-danger">{message}</p>}
      <button type="submit" disabled={busy} className="admin-btn admin-btn-primary">
        {busy ? "확인 중…" : "로그인"}
      </button>
      <button type="button" className="admin-btn admin-btn-quiet" onClick={() => setStep("email")}>
        이메일 다시 입력
      </button>
    </form>
  );
}
