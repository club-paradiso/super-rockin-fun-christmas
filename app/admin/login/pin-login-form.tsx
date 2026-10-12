"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/components/admin/api";

const PIN_LENGTH = 6;
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"] as const;

/** Big on-screen keypad so the PIN works the same on phones, tablets and the booth laptop. */
function PinPad({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex justify-center gap-3"
        aria-label={`PIN ${value.length}/${PIN_LENGTH}자리 입력됨`}
        data-testid="pin-dots"
      >
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span
            key={i}
            className={`h-5 w-5 rounded-full border-2 border-cream/60 ${i < value.length ? "bg-amber" : ""}`}
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {KEYS.map((k, i) =>
          k === "" ? (
            <span key={i} />
          ) : (
            <button
              key={i}
              type="button"
              aria-label={k === "⌫" ? "지우기" : k}
              className="admin-btn min-h-16 bg-dusk text-2xl font-bold"
              onClick={() =>
                onChange(k === "⌫" ? value.slice(0, -1) : (value + k).slice(0, PIN_LENGTH))
              }
            >
              {k}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

/** Hub login: tap your name, type your PIN. */
export function PinLoginForm({ staff }: { staff: { userId: string; displayName: string }[] }) {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(staff.length === 1 ? staff[0]!.userId : null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!userId || pin.length !== PIN_LENGTH) return;
    setBusy(true);
    setMessage(null);
    const res = await postJson("/api/admin/auth/pin", { userId, pin }, { redirectOn401: false });
    setBusy(false);
    if (res.ok) {
      router.replace("/admin");
      router.refresh();
      return;
    }
    setPin("");
    setMessage(
      res.status === 429
        ? "시도가 너무 많아요. 15분 뒤에 다시 해 주세요."
        : "PIN이 맞지 않아요. 다시 입력해 주세요.",
    );
  }

  if (staff.length === 0)
    return <p className="mt-6 text-lg text-mist">등록된 스태프가 없어요. 책임자에게 문의하세요.</p>;

  return (
    <form onSubmit={submit} className="mt-6 flex flex-col gap-5" data-testid="pin-login-form">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-lg text-cream">이름을 고르세요</legend>
        <div className="flex flex-wrap gap-2">
          {staff.map((s) => (
            <button
              key={s.userId}
              type="button"
              aria-pressed={userId === s.userId}
              className={`admin-btn ${userId === s.userId ? "admin-btn-primary" : "bg-dusk"}`}
              onClick={() => {
                setUserId(s.userId);
                setMessage(null);
              }}
            >
              {s.displayName}
            </button>
          ))}
        </div>
      </fieldset>
      {userId && (
        <>
          <p className="text-lg text-cream">PIN {PIN_LENGTH}자리</p>
          <PinPad value={pin} onChange={setPin} />
        </>
      )}
      {message && (
        <p role="alert" className="text-lg text-alert">
          {message}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || !userId || pin.length !== PIN_LENGTH}
        className="admin-btn admin-btn-primary"
      >
        {busy ? "확인 중…" : "로그인"}
      </button>
    </form>
  );
}

/** Fresh hub: the setup code from the hub console + the first staff member's name and PIN. */
export function HubSetupForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const res = await postJson(
      "/api/admin/auth/setup",
      { code, displayName: name, pin },
      { redirectOn401: false },
    );
    setBusy(false);
    if (res.ok) {
      router.replace("/admin");
      router.refresh();
      return;
    }
    setMessage(
      res.status === 403
        ? "설정 코드가 맞지 않아요. 허브 노트북 검은 창의 코드를 다시 확인해 주세요."
        : res.status === 429
          ? "시도가 너무 많아요. 15분 뒤에 다시 해 주세요."
          : (res.error ?? "입력을 확인해 주세요."),
    );
  }

  return (
    <form onSubmit={submit} className="mt-6 flex flex-col gap-4" data-testid="hub-setup-form">
      <p className="text-lg text-mist">
        처음 쓰는 허브예요. 허브 노트북의 검은 창에 나온{" "}
        <strong className="text-cream">설정 코드</strong>로 첫 스태프를 만드세요.
      </p>
      <label className="flex flex-col gap-2 text-lg text-cream">
        설정 코드
        <input
          required
          autoCapitalize="characters"
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="admin-input text-center text-2xl tracking-[0.3em]"
        />
      </label>
      <label className="flex flex-col gap-2 text-lg text-cream">
        이름
        <input
          required
          maxLength={64}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="admin-input"
        />
      </label>
      <p className="text-lg text-cream">새 PIN {PIN_LENGTH}자리</p>
      <PinPad value={pin} onChange={setPin} />
      {message && (
        <p role="alert" className="text-lg text-alert">
          {message}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || pin.length !== PIN_LENGTH}
        className="admin-btn admin-btn-primary"
      >
        {busy ? "만드는 중…" : "첫 스태프 만들기"}
      </button>
    </form>
  );
}
