/**
 * Seeds a hub data folder with MEASURE_PHOTOS photos (default 3000) through the real
 * PhotoService on the real local backend, before the hub server starts. Not through HTTP: the
 * upload limit (30 per kiosk per minute) would make thousands take hours.
 *
 * Mix (one heavy evening): 60% said yes to the wall, 25% no, 15% left without answering. Of the
 * yes answers: 70% approved, 5% rejected, 5% approved then hidden, 20% still waiting.
 * Capture times are spread over the last 4 hours so retention keeps them.
 *
 * Writes <out>/seed.json: time per write as the database grows (every write rewrites db.json).
 *
 *   MEASURE_DATA=.data-measure MEASURE_OUT=docs/measurements/raw npx jiti measure/seed.ts
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createLocalBackend, flushLocalBackends } from "@/lib/storage/local-backend";
import { PhotoService } from "@/lib/storage/photo-service";
import { syntheticStrip } from "./images";

const COUNT = Number(process.env.MEASURE_PHOTOS ?? 3000);
const DATA = path.resolve(process.env.MEASURE_DATA ?? ".data-measure");
const OUT = path.resolve(process.env.MEASURE_OUT ?? "docs/measurements/raw");
const STAFF = "00000000-0000-4000-8000-00000000seed".replace("seed", "5eed");

const start = Date.now() - 4 * 3600_000;
let i = 0;
const svc = new PhotoService(createLocalBackend(DATA), {
  linkTtlHours: 72,
  retentionDays: 30,
  // Each photo is captured a little after the previous one.
  now: () => new Date(start + (i * 4 * 3600_000) / COUNT),
});

type Kind = "approved" | "rejected" | "hidden" | "pending" | "no" | "none";
function kindOf(n: number): Kind {
  const r = (n * 7919) % 100; // deterministic spread
  if (r < 25) return "no";
  if (r < 40) return "none";
  const y = (n * 104729) % 100;
  if (y < 70) return "approved";
  if (y < 75) return "rejected";
  if (y < 80) return "hidden";
  return "pending";
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

async function main() {
  await mkdir(OUT, { recursive: true });
  const images = await Promise.all(Array.from({ length: 12 }, (_, n) => syntheticStrip(n)));
  const counts: Record<Kind, number> = {
    approved: 0,
    rejected: 0,
    hidden: 0,
    pending: 0,
    no: 0,
    none: 0,
  };
  const buckets: { photos: number; writeMsP50: number; writeMsP95: number; dbBytes: number }[] = [];
  let writes: number[] = [];
  const timed = async <T>(fn: () => Promise<T>) => {
    const t = performance.now();
    const r = await fn();
    writes.push(performance.now() - t);
    return r;
  };
  const began = Date.now();
  for (i = 0; i < COUNT; i++) {
    const sessionId = randomUUID();
    const put = await timed(() =>
      svc.put({
        sessionId,
        kioskId: null,
        frameId: i % 5 === 0 ? "village-window" : i % 2 ? "starlight-strip" : "snow-paper-strip",
        mime: "image/jpeg",
        data: images[i % images.length]!,
      }),
    );
    const kind = kindOf(i);
    counts[kind]++;
    if (kind !== "none")
      await timed(() => svc.setWallConsentForSession(sessionId, kind !== "no", null));
    const id = put.photo.id;
    if (kind === "approved" || kind === "hidden")
      await timed(() => svc.moderate(id, "approve", STAFF));
    if (kind === "rejected") await timed(() => svc.moderate(id, "reject", STAFF));
    if (kind === "hidden") await timed(() => svc.moderate(id, "hide", STAFF));
    if ((i + 1) % 250 === 0) {
      await flushLocalBackends();
      const dbBytes = (await stat(path.join(DATA, "db.json"))).size;
      buckets.push({
        photos: i + 1,
        writeMsP50: +pct(writes, 50).toFixed(1),
        writeMsP95: +pct(writes, 95).toFixed(1),
        dbBytes,
      });
      console.log(JSON.stringify(buckets.at(-1)));
      writes = [];
    }
  }
  await flushLocalBackends();
  const result = {
    photos: COUNT,
    counts,
    seconds: Math.round((Date.now() - began) / 1000),
    imageBytes: images.map((b) => b.length),
    buckets,
  };
  await writeFile(path.join(OUT, "seed.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ ...result, buckets: buckets.length }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
