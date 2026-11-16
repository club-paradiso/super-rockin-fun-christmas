import { describe, expect, it } from "vitest";
import { createMemoryBackend } from "@/lib/storage/memory-backend";
import { PhotoService } from "@/lib/storage/photo-service";
import { cleanOrdinal, seoulDayStart } from "@/lib/studio/day";
import {
  LIGHT,
  TICKET_SIZE,
  drawStampTicket,
  ticketFileName,
  ticketFontRequests,
} from "@/lib/studio/ticket";
import { zigzagClip } from "@/components/studio/stamp-ticket";
import { WALL_LIGHT, wallPhotoShadow } from "@/lib/wall/themes";
import { FakeCanvas } from "../helpers/fake-canvas";
import { JPEG, uuid } from "../helpers/images";

describe("Seoul day (stamp ticket)", () => {
  it("starts the day at 00:00 KST (15:00 UTC the day before), whatever the time", () => {
    expect(seoulDayStart("2026-12-24T14:59:59.999Z")).toBe("2026-12-23T15:00:00.000Z");
    expect(seoulDayStart("2026-12-24T15:00:00.000Z")).toBe("2026-12-24T15:00:00.000Z");
    expect(seoulDayStart(new Date("2026-12-25T03:00:00+09:00"))).toBe("2026-12-24T15:00:00.000Z");
  });
  it("refuses an invalid date", () => {
    expect(() => seoulDayStart("not a date")).toThrow(RangeError);
  });
  it("accepts only whole numbers from 1 as a ticket number", () => {
    expect(cleanOrdinal(12)).toBe(12);
    for (const bad of [0, -1, 1.5, "3", null, undefined, Number.NaN, Infinity])
      expect(cleanOrdinal(bad)).toBeNull();
  });
});

describe("오늘 N번째 기록 (PhotoService.dayOrdinal)", () => {
  it("counts the Seoul day's photos up to this one, and starts again at midnight KST", async () => {
    let now = new Date("2026-12-24T14:58:00Z"); // 23:58 KST, 24 Dec
    const svc = new PhotoService(createMemoryBackend(), {
      linkTtlHours: 72,
      retentionDays: 30,
      now: () => now,
    });
    const put = () =>
      svc.put({
        sessionId: uuid(),
        kioskId: null,
        frameId: "starlight-strip",
        mime: "image/jpeg",
        data: JPEG,
      });
    const a = await put();
    now = new Date("2026-12-24T14:59:00Z");
    const b = await put();
    now = new Date("2026-12-24T15:00:00Z"); // 00:00 KST, 25 Dec
    const c = await put();
    expect(await svc.dayOrdinal(a.photo.createdAt)).toBe(1);
    expect(await svc.dayOrdinal(b.photo.createdAt)).toBe(2);
    expect(await svc.dayOrdinal(c.photo.createdAt)).toBe(1);
  });

  it("gives no number (instead of failing) when the count cannot be made", async () => {
    const backend = createMemoryBackend();
    backend.photos.countCreatedBetween = () => Promise.reject(new Error("db down"));
    const svc = new PhotoService(backend, { linkTtlHours: 72, retentionDays: 30 });
    expect(await svc.dayOrdinal(new Date().toISOString())).toBeNull();
    expect(await svc.dayOrdinal("garbage")).toBeNull();
  });
});

describe("stamp ticket picture", () => {
  const text = { date: "2026.12.24", record: "오늘 12번째 기록", event: "Christmas Village 2026" };
  const image = {} as CanvasImageSource;

  it("is a 1080 × 1920 story with the stamp ring and the outlined lockup", () => {
    let made: FakeCanvas | null = null;
    drawStampTicket((w, h) => (made = new FakeCanvas(w, h)), text, { stamp: image, lockup: image });
    const canvas = made as unknown as FakeCanvas;
    expect([canvas.width, canvas.height]).toEqual([TICKET_SIZE.width, TICKET_SIZE.height]);
    expect(canvas.callsTo("drawImage")).toHaveLength(2);
    const texts = canvas.callsTo("fillText").map((c) => c.args[0]);
    expect(texts).toEqual(expect.arrayContaining([text.date, text.record, text.event]));
  });

  it("draws the ring and the name itself when the pictures are missing", () => {
    let made: FakeCanvas | null = null;
    drawStampTicket((w, h) => (made = new FakeCanvas(w, h)), text);
    const canvas = made as unknown as FakeCanvas;
    expect(canvas.callsTo("drawImage")).toHaveLength(0);
    expect(canvas.callsTo("arc")).toHaveLength(2);
    expect(canvas.callsTo("fillText").map((c) => c.args[0])).toContain("STUDIO SHALOM");
  });

  it("names the file without anything personal", () => {
    expect(ticketFileName("2026.12.24", 12)).toBe("studio-shalom-2026-12-24-12.png");
    expect(ticketFileName("2026.12.24", null)).toBe("studio-shalom-2026-12-24.png");
  });

  it("loads the fonts for exactly the text it draws", () => {
    const requests = ticketFontRequests(text);
    expect(requests[0]!.text).toBe(text.record);
  });

  it("tears both ends of a ticket into teeth", () => {
    const clip = zigzagClip(4, 8);
    expect(clip.startsWith("polygon(0 8px, 12.500% 0, 25.000% 8px")).toBe(true);
    expect(clip).toContain("calc(100% - 8px)");
  });
});

describe("one light, top left (135°)", () => {
  it("casts every shadow down and to the right: ticket, wall photos, twine", () => {
    for (const offset of [LIGHT, WALL_LIGHT.photo, WALL_LIGHT.rope]) {
      expect(offset.x).toBeGreaterThan(0);
      expect(offset.y).toBeGreaterThan(0);
      // Roughly 135°: the drop is steeper than it is wide, never flat or vertical.
      expect(offset.y / offset.x).toBeGreaterThan(1);
      expect(offset.y / offset.x).toBeLessThan(2);
    }
    expect(wallPhotoShadow("filter")).toBe("drop-shadow(10px 14px 22px var(--wall-photo-shadow))");
    expect(wallPhotoShadow("box")).toBe("10px 14px 22px var(--wall-photo-shadow)");
  });
});

describe("one light in the stylesheet", () => {
  // Every shadow written in app/globals.css: box-shadow, text-shadow, drop-shadow() and the
  // shadow tokens. Inset layers (a lit edge, a recessed tray) and 0 0 0 rings are not cast shadows.
  it("casts every shadow down and to the right", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("app/globals.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const values: string[] = [];
    for (const m of css.matchAll(
      /(?:box-shadow|text-shadow|--shadow-[\w-]+|--drop-[\w-]+)\s*:\s*([^;]+);/g,
    ))
      values.push(m[1]!);
    for (const m of css.matchAll(/drop-shadow\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g))
      values.push(m[1]!);
    const layers = values.flatMap((v) => {
      const out: string[] = [];
      let depth = 0;
      let cur = "";
      for (const ch of v) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (ch === "," && depth === 0) {
          out.push(cur);
          cur = "";
        } else cur += ch;
      }
      return [...out, cur].map((l) => l.trim());
    });
    const cast = layers.filter((l) => !/inset|^var\(|^none$/.test(l) && /\dpx/.test(l));
    expect(cast.length).toBeGreaterThan(10);
    const wrong = cast.filter((l) => {
      const [x, y, blur, spread] = [...l.matchAll(/(-?\d*\.?\d+)px/g)].map((m) => Number(m[1]));
      if (x === 0 && y === 0 && !blur && spread) return false; // an outline ring
      return !(x! > 0 && y! > 0);
    });
    expect(wrong).toEqual([]);
    expect(css).toContain(
      `--wall-photo-drop: ${WALL_LIGHT.photo.x}px ${WALL_LIGHT.photo.y}px ${WALL_LIGHT.photo.blur}px`,
    );
  });
});
