import { redirect } from "next/navigation";

/** The booth itself is the default surface. /wall and /admin are opened directly by staff. */
export default function Home() {
  redirect("/kiosk");
}
