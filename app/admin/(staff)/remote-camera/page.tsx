import { RemoteCameraManager } from "@/components/admin/remote-camera-manager";
import { requireStaff } from "@/lib/staff-auth/page";

export const dynamic = "force-dynamic";

export default async function RemoteCameraPage() {
  await requireStaff();
  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <h1 className="admin-h1">원격 카메라 관리</h1>
      <p className="text-base text-ink/75">
        아이폰을 키오스크의 후면 카메라로 씁니다. 사진은 아이폰에서 아이패드로 직접 가고, 이
        서버에는 남지 않아요. 키오스크는 주소 끝에 <span className="font-mono">?camera=remote</span>
        를 붙여 열면 아이폰 카메라를 써요.
      </p>
      <RemoteCameraManager />
    </div>
  );
}
