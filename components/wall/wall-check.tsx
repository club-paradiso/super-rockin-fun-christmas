"use client";

import { useEffect, useState } from "react";
import { wallShapeCheck } from "@/lib/wall/embed";
import type { WallAudience, WallFeedMode } from "@/lib/wall/states";

const MODE: Record<WallFeedMode, string> = {
  live: "켜짐",
  paused: "일시정지 (관리자)",
  holding: "대기 화면 (관리자)",
  closed: "운영 시간 밖",
};

/**
 * 점검 (`/wall?check=1`, lib/wall/embed.ts): what this page was given and what it is doing, in
 * numbers, drawn over the wall for the person setting it up in a show program. Counts and sizes
 * only: no photo ids, nothing a guest could not see. The clock and the drawing rate are there to
 * tell a wall that is still by design (a photo stays up for seconds) from a picture that stopped.
 */
export function WallCheck(p: {
  viewport: { width: number; height: number };
  canvas: { width: number; height: number } | null;
  embed: boolean;
  fit: string | null;
  /** Photos this screen hangs at once, and the least asked for in the address (0 = none). */
  places: number;
  minPhotos: number;
  audience: WallAudience | null;
  mode: WallFeedMode | null;
  online: boolean;
  answeredSecondsAgo: number | null;
  eligible: number;
  loaded: number;
  hanging: number;
  now: number;
}) {
  // Animation frames per second, measured here so the check costs nothing when it is off.
  const [fps, setFps] = useState<number | null>(null);
  const [dpr, setDpr] = useState(1);
  useEffect(() => {
    let count = 0;
    let raf = requestAnimationFrame(function frame() {
      count++;
      raf = requestAnimationFrame(frame);
    });
    const id = setInterval(() => {
      setFps(count);
      setDpr(window.devicePixelRatio || 1);
      count = 0;
    }, 1_000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(id);
    };
  }, []);

  const shape = wallShapeCheck(p.viewport, p.canvas);
  const clock = new Date(p.now).toLocaleTimeString("ko-KR", { hour12: false });
  const rows: [string, string, boolean?][] = [
    ["화면 크기", `${shape.size} px · 비율 ${shape.ratio} : 1 · 배율 ${dpr}`],
    ["맞춤", p.fit ?? "계산 중"],
    [
      "사진 자리",
      `한 번에 ${p.places}장${p.minPhotos ? ` (주소의 photos=${p.minPhotos})` : " (자동)"}`,
    ],
    [
      "이 화면",
      p.audience === "display"
        ? "등록된 행사장 화면 (승인된 사진 전부)"
        : p.audience === "public"
          ? "등록 안 됨: 공개 화면 (공개 동의 사진만, 공개가 꺼져 있으면 0장)"
          : "서버 응답 기다리는 중",
      p.audience === "public",
    ],
    ["미디어월", p.mode ? MODE[p.mode] : "-", !!p.mode && p.mode !== "live"],
    ["사진", `받을 수 있는 ${p.eligible}장 · 불러온 ${p.loaded}장 · 걸린 ${p.hanging}장`],
    [
      "서버 응답",
      p.answeredSecondsAgo === null
        ? "아직 없음"
        : `${p.answeredSecondsAgo}초 전${p.online ? "" : " · 지금 연결 안 됨"}`,
      !p.online || p.answeredSecondsAgo === null,
    ],
    [
      "화면 그리기",
      fps === null
        ? "재는 중"
        : fps === 0
          ? "초당 0번: 이 프로그램이 지금 페이지를 그리지 않아요"
          : `초당 ${fps}번`,
      fps === 0,
    ],
    ["시계", `${clock} (멈춰 보이면 화면이 멈춘 것)`],
    ["모드", p.embed ? "embed=1 (전체화면 버튼 없음)" : "일반 브라우저"],
  ];
  if (shape.mismatch && p.canvas)
    rows.splice(1, 0, [
      "비율 경고",
      `LED 크기 ${p.canvas.width} × ${p.canvas.height} 와 이 화면 비율이 달라 띠가 생겨요. 프로그램의 렌더 크기를 LED 크기로 맞추세요.`,
      true,
    ]);

  return (
    <aside className="wall-check" data-testid="wall-check" aria-label="미디어월 점검">
      <p className="wall-check-title">STAFF · 미디어월 점검 (주소의 check=1 을 지우면 사라져요)</p>
      <dl>
        {rows.map(([name, value, warn]) => (
          <div key={name} data-warn={warn ? "1" : undefined} data-row={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
