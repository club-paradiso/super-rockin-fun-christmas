"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { StaffMember } from "@/lib/storage/types";
import { errorText, postJson } from "./api";

export function StaffManager({ staff, selfId }: { staff: StaffMember[]; selfId: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(url: string, body: unknown) {
    setBusy(true);
    setError(null);
    const res = await postJson(url, body);
    setBusy(false);
    if (!res.ok) setError(errorText(res.error));
    router.refresh();
    return res.ok;
  }

  return (
    <section className="admin-card flex flex-col gap-4 p-4">
      <h2 className="text-2xl font-bold">스태프</h2>
      <ul className="flex flex-col gap-2">
        {staff.map((m) => (
          <li
            key={m.userId}
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-ink p-3"
            data-testid="staff-item"
          >
            <span>
              <strong className="text-lg">{m.displayName}</strong>{" "}
              <span className="text-mist">{m.email}</span>{" "}
              {!m.active && (
                <span className="rounded-full bg-dusk px-2 py-0.5 text-sm text-mist">비활성</span>
              )}
            </span>
            {m.userId !== selfId && (
              <button
                type="button"
                className={`admin-btn ${m.active ? "admin-btn-quiet" : "admin-btn-approve"}`}
                disabled={busy}
                onClick={() => send(`/api/admin/staff/${m.userId}`, { active: !m.active })}
              >
                {m.active ? "비활성화" : "다시 활성화"}
              </button>
            )}
          </li>
        ))}
      </ul>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await send("/api/admin/staff", { email, displayName: name })) {
            setEmail("");
            setName("");
          }
        }}
      >
        <input
          aria-label="이메일"
          type="email"
          required
          placeholder="이메일"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="admin-input min-w-0 flex-1"
        />
        <input
          aria-label="이름"
          required
          placeholder="이름"
          maxLength={64}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="admin-input min-w-0 flex-1"
        />
        <button type="submit" className="admin-btn admin-btn-primary" disabled={busy}>
          스태프 추가
        </button>
      </form>
      <p className="text-base text-mist">
        추가된 사람은 이메일로 받은 6자리 코드로 로그인해요. 비밀번호는 없어요.
      </p>
      {error && <p className="text-alert">{error}</p>}
    </section>
  );
}
