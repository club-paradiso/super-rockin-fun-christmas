"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

const ITEMS = [
  ["/admin", "개요"],
  ["/admin/moderation", "검수"],
  ["/admin/sessions", "최근 세션"],
  ["/admin/photos", "사진"],
  ["/admin/kiosks", "키오스크"],
  ["/admin/settings", "설정"],
  ["/admin/audit", "기록"],
] as const;

/**
 * Section tabs: plain text with a 2 px rule under the current one. They scroll sideways on a phone
 * (seven do not fit), so the current tab is brought into view instead of being cut off at the edge.
 */
export function AdminNav() {
  const path = usePathname();
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = row.current;
    const current = el?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el || !current) return;
    el.scrollTo({
      left: current.offsetLeft - (el.clientWidth - current.offsetWidth) / 2,
      behavior: "auto",
    });
  }, [path]);
  return (
    <nav className="sticky top-0 z-10 border-b border-ink/15 bg-backdrop" aria-label="운영 메뉴">
      <div
        ref={row}
        className="mx-auto flex max-w-6xl overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {ITEMS.map(([href, label]) => {
          const active = href === "/admin" ? path === "/admin" : path.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`relative flex min-h-11 shrink-0 items-center px-3.5 text-[15px] font-semibold whitespace-nowrap ${
                active
                  ? "text-ink after:absolute after:inset-x-3.5 after:bottom-0 after:h-0.5 after:bg-ink"
                  : "text-ink/75 active:bg-ink/10"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
