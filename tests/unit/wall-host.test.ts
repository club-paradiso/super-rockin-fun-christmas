import { describe, expect, it } from "vitest";
import { WALL_CONFIG } from "@/config/wall";
import { parseWallHosts, wallHostRedirects, wallHostRewrites } from "@/lib/wall/host";
import { PHONE_CARD, phoneCardBox, wallLayout } from "@/lib/wall/layout";

describe("dedicated wall address (D68)", () => {
  it("parses hostnames and drops anything else", () => {
    expect(parseWallHosts(" Follow-The-Lights-Wall.vercel.app, bad host, https://x.org ,")).toEqual(
      ["follow-the-lights-wall.vercel.app"],
    );
    expect(parseWallHosts(undefined)).toEqual([]);
  });

  it("serves the wall at / of the wall host only (exact host match)", () => {
    const [rule] = wallHostRewrites(["wall.example.org"]);
    expect(rule).toEqual({
      source: "/",
      has: [{ type: "host", value: "^wall\\.example\\.org$" }],
      destination: "/wall",
    });
    expect(new RegExp(rule!.has[0]!.value).test("wall.example.org")).toBe(true);
    expect(new RegExp(rule!.has[0]!.value).test("wallXexample.org")).toBe(false);
    expect(new RegExp(rule!.has[0]!.value).test("evil-wall.example.org")).toBe(false);
  });

  it("sends booth, staff and guest pages on the wall host to the booth address", () => {
    const rules = wallHostRedirects(["wall.example.org"], "https://booth.example.org/");
    const sources = rules.map((r) => r.source);
    expect(sources).toEqual(["/admin", "/admin/:path*", "/kiosk", "/m/:path*", "/p/:path*"]);
    expect(
      rules.every((r) => !r.permanent && r.destination.startsWith("https://booth.example.org/")),
    ).toBe(true);
    // What the wall itself needs stays: enrollment, its API, the heartbeat.
    expect(sources.some((s) => s.startsWith("/kiosk/") || s.startsWith("/api"))).toBe(false);
  });

  // D87: the STUDIO SHALOM names are added next to the old ones. Both wall names are walls, both
  // send staff and guest pages to the NEW booth name, and nothing redirects in a circle.
  it("two wall names during the rename: both work, neither loops", () => {
    const hosts = parseWallHosts("studio-shalom-wall.vercel.app,follow-the-lights-wall.vercel.app");
    expect(hosts).toEqual(["studio-shalom-wall.vercel.app", "follow-the-lights-wall.vercel.app"]);
    expect(wallHostRewrites(hosts).map((r) => r.destination)).toEqual(["/wall", "/wall"]);
    const booth = "https://studio-shalom.vercel.app";
    const rules = wallHostRedirects(hosts, booth);
    expect(rules).toHaveLength(10);
    expect(rules.every((r) => r.destination.startsWith(`${booth}/`))).toBe(true);
    // No rule ever applies to the booth name itself (new or old): they keep serving directly, so
    // yesterday's QR links and booths enrolled on the old name keep working.
    const boothHosts = ["studio-shalom.vercel.app", "follow-the-lights.vercel.app"];
    for (const rule of [...rules, ...wallHostRewrites(hosts)])
      for (const host of boothHosts) expect(new RegExp(rule.has[0]!.value).test(host)).toBe(false);
    // Even if the booth address were (wrongly) set to one of the wall names, that name does not
    // redirect to itself.
    const self = wallHostRedirects(hosts, "https://studio-shalom-wall.vercel.app");
    expect(
      self.some((r) => new RegExp(r.has[0]!.value).test("studio-shalom-wall.vercel.app")),
    ).toBe(false);
  });

  it("no booth address, a bad one, or the same host: no redirects", () => {
    expect(wallHostRedirects(["wall.example.org"], null)).toEqual([]);
    expect(wallHostRedirects(["wall.example.org"], "not a url")).toEqual([]);
    expect(wallHostRedirects(["wall.example.org"], "https://wall.example.org")).toEqual([]);
  });
});

describe("phone photo card on the clothesline (D66)", () => {
  const layout = wallLayout(WALL_CONFIG.scene);
  it("stays inside the scene and never reaches a neighbouring slot's photo", () => {
    layout.slots.forEach((place, i) => {
      const card = phoneCardBox(place);
      expect(card.x).toBeGreaterThanOrEqual(0);
      expect(card.x + card.width).toBeLessThanOrEqual(layout.width);
      expect(card.y + card.height).toBeLessThanOrEqual(layout.height);
      const next = layout.slots[i + 1];
      if (next) {
        // Even if both neighbours are cards.
        expect(card.x + card.width).toBeLessThan(phoneCardBox(next).x);
      }
    });
  });

  it("is wider than a strip and no taller, so a landscape phone photo stays large", () => {
    expect(PHONE_CARD.width).toBeGreaterThan(WALL_CONFIG.scene.strip.width);
    expect(phoneCardBox(layout.slots[0]!).height).toBeLessThanOrEqual(
      WALL_CONFIG.scene.strip.height,
    );
  });
});
