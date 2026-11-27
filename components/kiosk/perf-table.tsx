"use client";

import { useState, useSyncExternalStore } from "react";
import { PERF_LABELS, boothPerf } from "@/lib/kiosk/perf";

/**
 * 「속도 기록」: how long this booth's steps took, as measured on this device since the page was
 * loaded (lib/kiosk/perf.ts). For staff: in the help menu, and behind `?perf=1` on the first
 * screen for a booth without the help menu. Milliseconds; nothing here is about a photo.
 */
export function PerfTable() {
  const log = boothPerf();
  useSyncExternalStore(log.subscribe, log.getVersion, () => 0);
  const rows = log.rows();
  if (rows.length === 0)
    return (
      <p className="text-lg text-ink/75" data-testid="perf-empty">
        아직 기록이 없어요. 한 번 찍어 보면 여기에 나와요.
      </p>
    );
  return (
    <table className="w-full border-collapse text-left text-base text-ink" data-testid="perf-table">
      <thead>
        <tr className="border-b border-ink/40">
          <th className="py-1 pr-2 font-bold">구간</th>
          <th className="px-2 py-1 text-right font-bold">횟수</th>
          <th className="px-2 py-1 text-right font-bold">최근</th>
          <th className="px-2 py-1 text-right font-bold">중앙값</th>
          <th className="py-1 pl-2 text-right font-bold">최대</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.code} className="border-b border-ink/15" data-perf={row.code}>
            <td className="py-1 pr-2">{PERF_LABELS[row.code]}</td>
            <td className="px-2 py-1 text-right tabular-nums">{row.count}</td>
            <td className="px-2 py-1 text-right tabular-nums" data-perf-last>
              {row.last}
            </td>
            <td className="px-2 py-1 text-right tabular-nums">{row.median}</td>
            <td className="py-1 pl-2 text-right tabular-nums">{row.max}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The unit and what the numbers are, under the table. */
export function PerfNote() {
  return (
    <p className="text-base text-ink/75">
      단위는 밀리초(1000 = 1초). 이 기기에서, 화면을 연 뒤부터 잰 값이에요. 새로고침하면 지워져요.
    </p>
  );
}

/**
 * `?perf=1` only, on the first screen only: a small "속도 기록" button in the bottom-left corner
 * that opens the table. A guest never sees it (the address is typed by staff).
 */
export function PerfCorner() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="perf-open"
        className="fixed bottom-2 left-2 z-40 min-h-12 rounded-lg border border-ink/40 bg-paper px-4 text-base font-bold text-ink"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        속도 기록
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="속도 기록"
          data-testid="perf-panel"
          className="fixed inset-0 z-50 flex items-center justify-center bg-backdrop p-6"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex max-h-full w-full max-w-2xl flex-col gap-4 overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-3xl font-bold text-ink">속도 기록</h2>
              <button
                type="button"
                className="btn-quiet"
                data-testid="perf-close"
                onClick={() => setOpen(false)}
              >
                닫기
              </button>
            </div>
            <PerfTable />
            <PerfNote />
          </div>
        </div>
      )}
    </>
  );
}
