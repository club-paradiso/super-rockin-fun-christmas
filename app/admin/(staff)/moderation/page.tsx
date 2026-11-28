import Link from "next/link";
import { AiReviewPanel } from "@/components/admin/ai-review-panel";
import { PhotoCard } from "@/components/admin/photo-card";
import { WallBulk } from "@/components/admin/wall-bulk";
import type { PhotoSource } from "@/config/mobile";
import { sweepAiReviewSoon } from "@/lib/moderation/server";
import {
  MODERATION_VIEWS,
  getAiOverview,
  moderationSection,
  pendingQueue,
  wallSection,
  type ModerationView,
  type StaffPhotoView,
} from "@/lib/ops/admin";
import { requireStaff } from "@/lib/staff-auth/page";
import { getBackend } from "@/lib/storage/server";

export const dynamic = "force-dynamic";

const FILTERS: { key: PhotoSource | "all"; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "booth", label: "현장 촬영" },
  { key: "mobile", label: "휴대폰 사진" },
];

/** The sections of this page (D95). The queue is the job; the others are where to look back. */
const VIEWS: Record<ModerationView, { label: string; tab?: string; lead: string; empty: string }> =
  {
    queue: {
      label: "검수 대기",
      // Six tabs, three to a row on a phone: the short word keeps each on one line.
      tab: "대기",
      lead: "미디어월 동의 + 검수 대기 · AI 주의 먼저, 그다음 오래된 순",
      empty: "검수할 사진이 없어요.",
    },
    wall: {
      label: "게시 중",
      lead: "지금 미디어월에 나갈 수 있는 사진 전부 · 사람·AI 승인 모두 · 골라서 한 번에 내리기",
      empty: "미디어월에 올라간 사진이 없어요.",
    },
    flagged: {
      label: "AI 주의",
      lead: "AI가 문제가 있어 보인다고 표시한 사진 · 사람이 보고 정해요",
      empty: "AI가 주의로 표시한 사진이 없어요.",
    },
    "ai-approved": {
      label: "AI 승인",
      lead: "AI가 승인해 미디어월에 나가는 사진 · 이상하면 바로 숨기기",
      empty: "AI가 승인한 사진이 없어요.",
    },
    rejected: {
      label: "반려",
      lead: "스태프가 반려한 사진 · 다시 검수로 되돌릴 수 있어요",
      empty: "반려한 사진이 없어요.",
    },
    hidden: {
      label: "숨김",
      lead: "미디어월에서 숨긴 사진 · 다시 보이게 할 수 있어요",
      empty: "숨긴 사진이 없어요.",
    },
  };

/**
 * The main job: consented photos waiting for a human decision. Booth photos and guests' own phone
 * photos (D66) share one queue and one set of rules; the source filter only narrows it. With the
 * automatic check on (D95), what the AI approved, flagged or could not read is one tap away, and
 * every photo on this page can still be approved, rejected, hidden or deleted by a person.
 */
export default async function ModerationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireStaff();
  const { source, view: rawView, before: rawBefore } = await searchParams;
  const view: ModerationView = (MODERATION_VIEWS as readonly string[]).includes(String(rawView))
    ? (rawView as ModerationView)
    : "queue";
  const filter: PhotoSource | undefined =
    source === "mobile" ? "mobile" : source === "booth" ? "booth" : undefined;
  // A staff member looking at the queue is a good moment to push it along.
  sweepAiReviewSoon();
  const before = typeof rawBefore === "string" ? rawBefore : undefined;
  const [section, ai, settings] = await Promise.all([
    loadView(view, filter, before),
    getAiOverview(),
    getBackend().settings.get(),
  ]);
  const { photos, total, nextBefore } = section;
  const meta = VIEWS[view];
  const sourceQuery = filter ? `&source=${filter}` : "";
  const viewBase = view === "queue" ? "/admin/moderation?" : `/admin/moderation?view=${view}&`;
  const firstPage =
    view === "queue"
      ? `/admin/moderation${filter ? `?source=${filter}` : ""}`
      : `/admin/moderation?view=${view}${sourceQuery}`;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="admin-h1" data-testid="view-count">
          {meta.label} {total ?? photos.length}건
        </h1>
        <p className="text-base text-ink/75">{meta.lead}</p>
      </div>
      <AiReviewPanel ai={ai} settings={settings} />
      <nav
        className="admin-seg grid-flow-row grid-cols-3 md:w-fit md:grid-flow-col md:grid-cols-none md:auto-cols-[7.5rem]"
        aria-label="검수 구역"
      >
        {MODERATION_VIEWS.map((v) => (
          <Link
            key={v}
            href={v === "queue" ? "/admin/moderation" : `/admin/moderation?view=${v}`}
            aria-current={view === v ? "page" : undefined}
            data-testid={`view-${v}`}
            className="admin-seg-btn"
          >
            {VIEWS[v].tab ?? VIEWS[v].label}
          </Link>
        ))}
      </nav>
      {(view === "queue" || view === "wall") && (
        <nav
          className="admin-seg md:w-fit md:grid-flow-col md:auto-cols-[8rem]"
          aria-label="사진 출처"
        >
          {FILTERS.map((f) => {
            const active = (filter ?? "all") === f.key;
            return (
              <Link
                key={f.key}
                href={f.key === "all" ? viewBase.slice(0, -1) : `${viewBase}source=${f.key}`}
                aria-current={active ? "page" : undefined}
                data-testid={`queue-filter-${f.key}`}
                className="admin-seg-btn"
              >
                {f.label}
              </Link>
            );
          })}
        </nav>
      )}
      {total !== undefined && (
        <p className="text-base text-ink/75" data-testid="view-page-count">
          이 페이지 {photos.length}장
          {filter ? ` (${filter === "mobile" ? "휴대폰 사진" : "현장 촬영"}만)` : ""}
          {nextBefore ? " · 아래 「더 오래된 사진 보기」로 나머지" : ""}
        </p>
      )}
      {photos.length === 0 ? (
        <p className="admin-card p-8 text-center text-base text-ink/75" data-testid="queue-empty">
          {meta.empty}
        </p>
      ) : view === "wall" ? (
        <WallBulk photos={photos} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="moderation-queue">
          {photos.map((p) => (
            <PhotoCard key={p.id} photo={p} primaryOnly={view === "queue" || view === "flagged"} />
          ))}
        </div>
      )}
      {(before || nextBefore) && (
        <nav className="flex flex-wrap justify-between gap-2" aria-label="페이지">
          {before ? (
            <Link href={firstPage} className="admin-btn admin-btn-quiet">
              처음으로
            </Link>
          ) : (
            <span />
          )}
          {nextBefore && (
            <Link
              href={`${viewBase}before=${encodeURIComponent(nextBefore)}${sourceQuery}`}
              className="admin-btn admin-btn-quiet"
              data-testid="wall-older"
            >
              더 오래된 사진 보기
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}

interface Section {
  photos: StaffPhotoView[];
  /** The whole count when the view is paged (「게시 중」); otherwise the list is the whole view. */
  total?: number;
  nextBefore: string | null;
}

async function loadView(
  view: ModerationView,
  source: PhotoSource | undefined,
  before: string | undefined,
): Promise<Section> {
  if (view === "queue") return { photos: await pendingQueue(60, source), nextBefore: null };
  if (view === "wall") return wallSection({ before, source });
  return { photos: await moderationSection(view), nextBefore: null };
}
