/**
 * Where the check page (/camera-lab) is served: in development, on Vercel preview deployments,
 * and wherever `CAMERA_LAB=1` is set (a hub, to check the real iPad). `CAMERA_LAB=0` turns it
 * off everywhere. On a production deployment without the variable it is a 404.
 */
export function cameraLabEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.CAMERA_LAB === "1") return true;
  if (env.CAMERA_LAB === "0") return false;
  return env.NODE_ENV !== "production" || env.VERCEL_ENV === "preview";
}
