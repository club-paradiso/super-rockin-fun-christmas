import { EmergencyPanel } from "@/components/admin/emergency-panel";
import { EventClose } from "@/components/admin/event-close";
import { PublicWallForm } from "@/components/admin/public-wall-form";
import { WallLookForm } from "@/components/admin/wall-look-form";
import { WALL_CONFIG } from "@/config/wall";
import { DEFAULT_WALL_THEME, WALL_THEMES } from "@/config/wall-themes";
import { parseWallHosts } from "@/lib/wall/host";
import { activeThemeId, normalizeLook } from "@/lib/wall/themes";
import { wallOpen } from "@/lib/wall/hours";
import { formatTime } from "@/components/admin/labels";
import { StaffManager } from "@/components/admin/staff-manager";
import { WallHoursForm } from "@/components/admin/wall-hours-form";
import { eventCloseAllowed } from "@/lib/ops/event-close";
import { getServerConfig } from "@/lib/server/env";
import { requireStaff } from "@/lib/staff-auth/page";
import { SHARED_OPERATOR, isSharedOperator } from "@/lib/staff-auth/shared";
import { getBackend } from "@/lib/storage/server";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const me = await requireStaff();
  const backend = getBackend();
  const [settings, staff, stats, onWall, onPublicWall] = await Promise.all([
    backend.settings.get(),
    backend.staff.list(),
    backend.photos.stats(),
    backend.photos.listWallEligible(20_000),
    backend.photos.listWallEligible(20_000, true),
  ]);
  const look = normalizeLook(settings.wallLook, WALL_THEMES, DEFAULT_WALL_THEME);
  const wallHost = parseWallHosts(process.env.WALL_HOSTS)[0] ?? null;
  const updater = isSharedOperator(settings.updatedBy)
    ? SHARED_OPERATOR
    : staff.find((s) => s.userId === settings.updatedBy);
  const config = getServerConfig();
  const eventEnd = config.hubRetention?.eventEnd ?? null;
  const photosLeft = (Object.entries(stats.byStatus) as [string, number][])
    .filter(([status]) => status !== "DELETED")
    .reduce((sum, [, n]) => sum + n, 0);
  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <h1 className="admin-h1">설정</h1>
      <EmergencyPanel
        settings={settings}
        wallStatus={wallOpen(settings, new Date(), WALL_CONFIG.timeZone)}
      />
      <WallHoursForm hours={settings.wallHours} timeZone={WALL_CONFIG.timeZone} />
      <WallLookForm
        look={look}
        themes={WALL_THEMES.map(({ id, name, note, preview, status }) => ({
          id,
          name,
          note,
          preview,
          status,
        }))}
        defaultTheme={DEFAULT_WALL_THEME}
        activeTheme={currentTheme(look)}
      />
      <PublicWallForm
        enabled={settings.wallPublic}
        wallUrl={wallHost ? `https://${wallHost}` : null}
        publicCount={onPublicWall.length}
        venueOnlyCount={onWall.length - onPublicWall.length}
      />
      <p className="text-base text-ink/75">
        마지막 변경: {formatTime(settings.updatedAt)}
        {updater ? ` · ${updater.displayName}` : ""}
      </p>
      <StaffManager
        staff={staff}
        selfId={me.userId}
        mode={config.staffAuth?.mode === "pin" ? "pin" : "email"}
      />
      {config.role === "hub" && (
        <EventClose
          photosLeft={photosLeft}
          eventEnd={eventEnd ? formatTime(eventEnd.toISOString()) : null}
          allowed={eventCloseAllowed(eventEnd, new Date())}
        />
      )}
    </div>
  );
}

/** Outside the component: reading the clock is not allowed while rendering. */
function currentTheme(look: ReturnType<typeof normalizeLook>) {
  return activeThemeId(look, Date.now());
}
