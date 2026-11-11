"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  ["/admin", "개요"],
  ["/admin/moderation", "검수"],
  ["/admin/sessions", "최근 세션"],
  ["/admin/photos", "사진"],
  ["/admin/kiosks", "키오스크"],
  ["/admin/settings", "설정"],
  ["/admin/audit", "기록"],
] as const;

export function AdminNav() {
  const path = usePathname();
  return (
    <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-2 pb-2" aria-label="운영 메뉴">
      {ITEMS.map(([href, label]) => {
        const active = href === "/admin" ? path === "/admin" : path.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-12 shrink-0 items-center rounded-full px-4 text-lg font-semibold ${
              active ? "bg-button text-button-text" : "text-ink hover:bg-ink/15"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
