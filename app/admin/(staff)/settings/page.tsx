import { EmergencyPanel } from "@/components/admin/emergency-panel";
import { EventClose } from "@/components/admin/event-close";
import { KioskModeForm } from "@/components/admin/kiosk-mode-form";
import { WALL_CONFIG } from "@/config/wall";
import { wallOpen } from "@/lib/wall/hours";
import { formatTime } from "@/components/admin/labels";
import { StaffManager } from "@/components/admin/staff-manager";
import { WallHoursForm } from "@/components/admin/wall-hours-form";
import { eventCloseAllowed } from "@/lib/ops/event-close";
import { getServerConfig } from "@/lib/server/env";
import { requireStaff } from "@/lib/staff-auth/page";
import { getBackend } from "@/lib/storage/server";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const me = await requireStaff();
  const backend = getBackend();
  const [settings, staff, stats] = await Promise.all([
    backend.settings.get(),
    backend.staff.list(),
    backend.photos.stats(),
  ]);
  const updater = staff.find((s) => s.userId === settings.updatedBy);
  const config = getServerConfig();
  const eventEnd = config.hubRetention?.eventEnd ?? null;
  const photosLeft = (Object.entries(stats.byStatus) as [string, number][])
    .filter(([status]) => status !== "DELETED")
    .reduce((sum, [, n]) => sum + n, 0);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-bold">설정</h1>
      <EmergencyPanel
        settings={settings}
        wallStatus={wallOpen(settings, new Date(), WALL_CONFIG.timeZone)}
      />
      <WallHoursForm hours={settings.wallHours} timeZone={WALL_CONFIG.timeZone} />
      <KioskModeForm mode={settings.kioskDefaultMode} />
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
