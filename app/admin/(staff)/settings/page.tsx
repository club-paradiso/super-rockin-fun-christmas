import { EmergencyPanel } from "@/components/admin/emergency-panel";
import { WALL_CONFIG } from "@/config/wall";
import { wallOpen } from "@/lib/wall/hours";
import { formatTime } from "@/components/admin/labels";
import { StaffManager } from "@/components/admin/staff-manager";
import { WallHoursForm } from "@/components/admin/wall-hours-form";
import { getServerConfig } from "@/lib/server/env";
import { requireStaff } from "@/lib/staff-auth/page";
import { getBackend } from "@/lib/storage/server";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const me = await requireStaff();
  const backend = getBackend();
  const [settings, staff] = await Promise.all([backend.settings.get(), backend.staff.list()]);
  const updater = staff.find((s) => s.userId === settings.updatedBy);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-bold">설정</h1>
      <EmergencyPanel
        settings={settings}
        wallStatus={wallOpen(settings, new Date(), WALL_CONFIG.timeZone)}
      />
      <WallHoursForm hours={settings.wallHours} timeZone={WALL_CONFIG.timeZone} />
      <p className="text-base text-mist">
        마지막 변경: {formatTime(settings.updatedAt)}
        {updater ? ` · ${updater.displayName}` : ""}
      </p>
      <StaffManager
        staff={staff}
        selfId={me.userId}
        mode={getServerConfig().staffAuth?.mode === "pin" ? "pin" : "email"}
      />
    </div>
  );
}
