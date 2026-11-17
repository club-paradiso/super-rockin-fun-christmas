// The 2026 frame collection art (D102). Run after changing a design or the shared layout:
//
//   node scripts/frame-collection.mjs
//
// Writes public/frames/collection/<id>-art.svg (everything under the photos), <id>-lockup.svg
// (the STUDIO SHALOM lockup in the frame's ink) and, for the vintage frame only,
// vintage-christmas-corners.svg (the album photo corners, drawn over the photo corners).
//
// Everything is deterministic: the paper speckle and film grain come from a seeded PRNG, and all
// lettering is outlined from OFL fonts that ship in node_modules (Cormorant Garamond, IBM Plex
// Mono), because a canvas cannot rely on web fonts when the kiosk composes (tests/unit/frames).
// The numbers come from config/frames/collection-layout.ts, the same file the frame definitions
// read, so the art and the photo slots cannot drift apart.
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import opentype from "opentype.js";
import {
  COLLECTION,
  COLLECTION_PALETTES,
  collectionSlots,
} from "../config/frames/collection-layout.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "public/frames/collection");
const { width: W, height: H } = COLLECTION;
const SLOTS = collectionSlots();

const font = (pkg, file) =>
  opentype.parse(
    readFileSync(path.join(ROOT, "node_modules/@fontsource", pkg, "files", file)).buffer,
  );
const FONTS = {
  serif: font("cormorant-garamond", "cormorant-garamond-latin-500-normal.woff"),
  serifBold: font("cormorant-garamond", "cormorant-garamond-latin-600-normal.woff"),
  italic: font("cormorant-garamond", "cormorant-garamond-latin-500-italic.woff"),
  mono: font("ibm-plex-mono", "ibm-plex-mono-latin-500-normal.woff"),
};

// ── helpers ─────────────────────────────────────────────────────────────────────────────────
const r2 = (n) => Math.round(n * 100) / 100;

/** mulberry32, the same family as lib/compositor/geometry seededRandom. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const lining = new Map();

/** Glyphs for `s`, with lining figures where the font has them (Cormorant defaults to old-style). */
function glyphsFor(f, s) {
  if (!lining.has(f)) {
    const byName = new Map();
    for (let i = 0; i < f.glyphs.length; i++) {
      const g = f.glyphs.get(i);
      if (g.name?.endsWith(".lf")) byName.set(g.name, g);
    }
    lining.set(f, byName);
  }
  const byName = lining.get(f);
  // One glyph per character (no ligatures), so the art never depends on a shaping engine.
  return [...s].map((ch) =>
    /[0-9]/.test(ch) ? (byName.get(`${DIGITS[+ch]}.lf`) ?? f.charToGlyph(ch)) : f.charToGlyph(ch),
  );
}

/** Width of `text` set at `size` with `tracking` (em) between letters. */
function measure(f, text, size, tracking = 0) {
  const glyphs = glyphsFor(f, text);
  const scale = size / f.unitsPerEm;
  let w = 0;
  glyphs.forEach((g, i) => {
    w += g.advanceWidth * scale;
    if (i < glyphs.length - 1) {
      w += f.getKerningValue(g, glyphs[i + 1]) * scale + tracking * size;
    }
  });
  return w;
}

/** Outlined text as one <path>. `y` is the baseline. */
function text(f, s, { x, y, size, tracking = 0, align = "left", fill, opacity }) {
  const glyphs = glyphsFor(f, s);
  const scale = size / f.unitsPerEm;
  const width = measure(f, s, size, tracking);
  let cx = align === "center" ? x - width / 2 : align === "right" ? x - width : x;
  let d = "";
  glyphs.forEach((g, i) => {
    d += g.getPath(cx, y, size).toPathData(2);
    cx += g.advanceWidth * scale;
    if (i < glyphs.length - 1) cx += f.getKerningValue(g, glyphs[i + 1]) * scale + tracking * size;
  });
  return `<path d="${d}" fill="${fill}"${opacity ? ` opacity="${opacity}"` : ""}/>`;
}

/** Text turned 90° (reading bottom to top), centred on (cx, cy). */
function verticalText(f, s, { cx, cy, size, tracking = 0, fill, opacity }) {
  const inner = text(f, s, {
    x: 0,
    y: size * 0.36,
    size,
    tracking,
    align: "center",
    fill,
    opacity,
  });
  return `<g transform="translate(${r2(cx)} ${r2(cy)}) rotate(-90)">${inner}</g>`;
}

const insideSlot = (x, y, pad = 0) =>
  SLOTS.some(
    (s) => x > s.x - pad && x < s.x + s.width + pad && y > s.y - pad && y < s.y + s.height + pad,
  );

/** Seeded specks outside the photos (photos cover the rest anyway). */
function specks(seed, count, { color, rMin, rMax, oMin, oMax, edgeBias = 0, area, avoid = [] }) {
  const rand = prng(seed);
  const box = area ?? { x: 0, y: 0, width: W, height: H };
  const out = [];
  let tries = 0;
  while (out.length < count && tries++ < count * 20) {
    let x = box.x + rand() * box.width;
    let y = box.y + rand() * box.height;
    if (edgeBias > 0 && rand() < edgeBias) {
      // Foxing gathers at the edges of old paper.
      const side = Math.floor(rand() * 4);
      const depth = rand() ** 2 * 70;
      if (side === 0) x = depth;
      else if (side === 1) x = W - depth;
      else if (side === 2) y = depth;
      else y = H - depth;
    }
    if (insideSlot(x, y)) continue;
    if (avoid.some((b) => x > b.x && x < b.x + b.width && y > b.y && y < b.y + b.height)) continue;
    const r = rMin + rand() * (rMax - rMin);
    const o = oMin + rand() * (oMax - oMin);
    out.push(`<circle cx="${r2(x)}" cy="${r2(y)}" r="${r2(r)}" opacity="${r2(o)}"/>`);
  }
  return `<g fill="${color}">${out.join("")}</g>`;
}

/** A four-pointed star like the one in the O of SHALOM, centred on (x, y), `size` tall. */
function star(x, y, size, fill, opacity = 1) {
  const h = size / 2;
  const w = size * 0.32;
  const k = size * 0.06;
  const d =
    `M${r2(x)} ${r2(y - h)}C${r2(x + k)} ${r2(y - k * 2)} ${r2(x + k * 2)} ${r2(y - k)} ${r2(x + w)} ${r2(y)}` +
    `C${r2(x + k * 2)} ${r2(y + k)} ${r2(x + k)} ${r2(y + k * 2)} ${r2(x)} ${r2(y + h)}` +
    `C${r2(x - k)} ${r2(y + k * 2)} ${r2(x - k * 2)} ${r2(y + k)} ${r2(x - w)} ${r2(y)}` +
    `C${r2(x - k * 2)} ${r2(y - k)} ${r2(x - k)} ${r2(y - k * 2)} ${r2(x)} ${r2(y - h)}Z`;
  return `<path d="${d}" fill="${fill}"${opacity < 1 ? ` opacity="${opacity}"` : ""}/>`;
}

function svg(title, body) {
  return (
    `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg">\n` +
    `<title>${title}</title>\n${body.join("\n")}\n</svg>\n`
  );
}

/** The STUDIO SHALOM lockup recoloured: letters (and the star in the O) in `ink`, divider in `accent`. */
function lockup(ink, accent) {
  const source = readFileSync(path.join(ROOT, "public/frames/shalom-lockup.svg"), "utf8");
  return source
    .replaceAll('fill="#2B1A10"', `fill="${ink}"`)
    .replaceAll('fill="#7A440E"', `fill="${accent}"`);
}

// ── 01 · Vintage Christmas ──────────────────────────────────────────────────────────────────
function vintage() {
  const c = COLLECTION_PALETTES["vintage-christmas"];
  const body = [`<rect width="${W}" height="${H}" fill="${c.paper}"/>`];
  // Aged paper: fine fibres everywhere, foxing towards the edges, a few faint stains.
  body.push(specks(101, 900, { color: c.speck, rMin: 0.3, rMax: 1.0, oMin: 0.05, oMax: 0.14 }));
  body.push(
    specks(102, 260, { color: c.speck, rMin: 0.6, rMax: 2.2, oMin: 0.03, oMax: 0.09, edgeBias: 1 }),
  );
  body.push(
    specks(103, 10, { color: c.speck, rMin: 10, rMax: 24, oMin: 0.012, oMax: 0.022, edgeBias: 1 }),
  );
  // A double rule, burgundy outside, brass inside, with a small brass lozenge in each corner.
  body.push(
    `<rect x="20" y="20" width="${W - 40}" height="${H - 40}" stroke="${c.ink}" stroke-width="2"/>`,
  );
  body.push(
    `<rect x="27" y="27" width="${W - 54}" height="${H - 54}" stroke="${c.accent}" stroke-width="0.8"/>`,
  );
  for (const [x, y] of [
    [27, 27],
    [W - 27, 27],
    [27, H - 27],
    [W - 27, H - 27],
  ]) {
    body.push(
      `<path d="M${x} ${y - 5}L${x + 5} ${y}L${x} ${y + 5}L${x - 5} ${y}Z" fill="${c.accent}"/>`,
    );
  }
  // Title, with two hand-drawn baubles hanging from the brass rule.
  body.push(
    text(FONTS.italic, "Christmas Memories", {
      x: W / 2,
      y: 86,
      size: 40,
      align: "center",
      fill: c.ink,
    }),
  );
  const bauble = (x, drop, r) => {
    const top = 27;
    const cy = top + drop + 6 + r;
    return [
      `<path d="M${x} ${top}V${top + drop}" stroke="${c.accent}" stroke-width="0.8"/>`,
      `<rect x="${x - 3}" y="${top + drop}" width="6" height="6" rx="1" fill="${c.accent}"/>`,
      `<circle cx="${x}" cy="${cy}" r="${r}" stroke="${c.accent}" stroke-width="1.2"/>`,
      `<path d="M${r2(x - r * 0.94)} ${r2(cy - r * 0.32)}Q${x} ${r2(cy - r * 0.08)} ${r2(x + r * 0.94)} ${r2(cy - r * 0.32)}" stroke="${c.accent}" stroke-width="0.7"/>`,
      `<path d="M${r2(x - r * 0.94)} ${r2(cy + r * 0.32)}Q${x} ${r2(cy + r * 0.56)} ${r2(x + r * 0.94)} ${r2(cy + r * 0.32)}" stroke="${c.accent}" stroke-width="0.7"/>`,
      `<circle cx="${x}" cy="${r2(cy + r * 0.12)}" r="1.4" fill="${c.ink}"/>`,
    ].join("");
  };
  body.push(bauble(82, 18, 10), bauble(518, 30, 8));
  // A brass hairline mat round every photo.
  for (const s of SLOTS) {
    body.push(
      `<rect x="${s.x - 7}" y="${s.y - 7}" width="${s.width + 14}" height="${s.height + 14}" stroke="${c.accent}" stroke-width="0.8"/>`,
    );
  }
  // Below the lockup: the year in letter-spaced capitals between two small rules.
  const line = "CHRISTMAS 2026";
  const lw = measure(FONTS.serifBold, line, 15, 0.32);
  body.push(
    text(FONTS.serifBold, line, {
      x: W / 2,
      y: 1746,
      size: 15,
      tracking: 0.32,
      align: "center",
      fill: c.ink,
    }),
  );
  for (const sign of [-1, 1]) {
    const x0 = W / 2 + sign * (lw / 2 + 14);
    body.push(
      `<path d="M${r2(x0)} 1741H${r2(x0 + sign * 26)}" stroke="${c.accent}" stroke-width="0.8"/>`,
    );
  }
  return svg("STUDIO SHALOM · Christmas Memories (art)", body);
}

/** Album photo corners: a burgundy pocket over each photo corner, brass edge along the cut. */
function vintageCorners() {
  const c = COLLECTION_PALETTES["vintage-christmas"];
  const L = 22;
  const body = [];
  for (const s of SLOTS) {
    const corners = [
      [s.x, s.y, 1, 1],
      [s.x + s.width, s.y, -1, 1],
      [s.x, s.y + s.height, 1, -1],
      [s.x + s.width, s.y + s.height, -1, -1],
    ];
    for (const [x, y, dx, dy] of corners) {
      // The pocket wraps 3 px past the photo edge, as the paper does.
      const ox = x - dx * 3;
      const oy = y - dy * 3;
      body.push(
        `<path d="M${ox} ${oy}H${ox + dx * (L + 3)}L${ox} ${oy + dy * (L + 3)}Z" fill="${c.ink}"/>`,
        `<path d="M${ox + dx * (L + 3)} ${oy}L${ox} ${oy + dy * (L + 3)}" stroke="${c.accent}" stroke-width="0.8"/>`,
      );
    }
  }
  return svg("STUDIO SHALOM · Christmas Memories (photo corners)", body);
}

// ── 02 · Peace on Earth ─────────────────────────────────────────────────────────────────────
/** A fine-line olive branch from (x, y), growing along `angle` (deg), `len` long; `flip` mirrors. */
function oliveBranch(x, y, len, angle, flip, c) {
  const leaves = [];
  const n = 6;
  for (let i = 0; i < n; i++) {
    const t = 0.18 + (i / (n - 1)) * 0.74;
    const side = i % 2 === 0 ? 1 : -1;
    const ll = 26 - i * 1.8;
    const lw = 5.2 - i * 0.3;
    const a = side * 38;
    leaves.push(
      `<g transform="translate(${r2(t * len)} ${r2(Math.sin(t * Math.PI) * -6)}) rotate(${a})">` +
        `<path d="M0 0Q${r2(ll * 0.5)} ${r2(-lw)} ${r2(ll)} 0Q${r2(ll * 0.5)} ${r2(lw)} 0 0Z" stroke="${c.speck}" stroke-width="1"/>` +
        `<path d="M1.5 0H${r2(ll * 0.82)}" stroke="${c.speck}" stroke-width="0.5"/></g>`,
    );
  }
  // Tip leaf and two olives.
  leaves.push(
    `<g transform="translate(${len} -1) rotate(-6)"><path d="M0 0Q8 -4 17 0Q8 4 0 0Z" stroke="${c.speck}" stroke-width="1"/></g>`,
    `<ellipse cx="${r2(len * 0.42)}" cy="9" rx="3.6" ry="2.6" fill="${c.ink}" opacity="0.75"/>`,
    `<ellipse cx="${r2(len * 0.7)}" cy="-11" rx="3.2" ry="2.3" fill="${c.ink}" opacity="0.75"/>`,
  );
  const stem = `<path d="M0 0Q${r2(len * 0.5)} -12 ${len} 0" stroke="${c.speck}" stroke-width="1.1"/>`;
  const scale = flip ? "scale(-1 1)" : "";
  return `<g transform="translate(${x} ${y}) ${scale} rotate(${angle})">${stem}${leaves.join("")}</g>`;
}

function peace() {
  const c = COLLECTION_PALETTES["peace-on-earth"];
  const body = [`<rect width="${W}" height="${H}" fill="${c.paper}"/>`];
  body.push(specks(201, 420, { color: c.speck, rMin: 0.3, rMax: 0.9, oMin: 0.04, oMax: 0.1 }));
  body.push(
    `<rect x="22" y="22" width="${W - 44}" height="${H - 44}" stroke="${c.accent}" stroke-width="0.75"/>`,
  );
  // The star over the title, and a few small ones in the margins: present, never loud.
  body.push(star(W / 2, 40, 16, c.accent));
  body.push(
    text(FONTS.serif, "PEACE ON EARTH", {
      x: W / 2,
      y: 92,
      size: 26,
      tracking: 0.36,
      align: "center",
      fill: c.ink,
    }),
  );
  for (const [x, y, s] of [
    [44, 330, 7],
    [557, 668, 9],
    [43, 1032, 6],
    [556, 1398, 7],
  ]) {
    body.push(star(x, y, s, c.accent, 0.85));
  }
  // Two olive branches reaching towards the lockup.
  body.push(oliveBranch(64, 1690, 82, -14, false, c));
  body.push(oliveBranch(W - 64, 1690, 82, -14, true, c));
  body.push(
    text(FONTS.serifBold, "CHRISTMAS 2026", {
      x: W / 2,
      y: 1748,
      size: 12,
      tracking: 0.4,
      align: "center",
      fill: c.ink,
    }),
  );
  return svg("STUDIO SHALOM · Peace on Earth (art)", body);
}

// ── 03 · Analog film ────────────────────────────────────────────────────────────────────────
function film() {
  const c = COLLECTION_PALETTES["analog-film"];
  const body = [`<rect width="${W}" height="${H}" fill="${c.paper}"/>`];
  body.push(specks(301, 1500, { color: c.speck, rMin: 0.3, rMax: 0.85, oMin: 0.025, oMax: 0.08 }));
  // Perforations down both edges.
  const holes = [];
  for (let y = 12; y + 18 <= H - 8; y += 28) {
    holes.push(`<rect x="18" y="${y}" width="12" height="18" rx="2.5"/>`);
    holes.push(`<rect x="${W - 30}" y="${y}" width="12" height="18" rx="2.5"/>`);
  }
  body.push(`<g fill="${c.ink}" opacity="0.88">${holes.join("")}</g>`);
  // Edge print: a frame number and arrow by each photo, the studio name on the other edge.
  SLOTS.forEach((s, i) => {
    const n = String(i + 1).padStart(2, "0");
    body.push(
      verticalText(FONTS.mono, n, {
        cx: 48,
        cy: s.y + 34,
        size: 11,
        tracking: 0.1,
        fill: c.accent,
      }),
    );
    const ay = s.y + 62;
    body.push(`<path d="M44 ${ay + 8}L48 ${ay}L52 ${ay + 8}Z" fill="${c.accent}"/>`);
    body.push(
      verticalText(FONTS.mono, i % 2 === 0 ? "STUDIO SHALOM" : "2026", {
        cx: W - 48,
        cy: s.y + s.height / 2,
        size: 9,
        tracking: 0.28,
        fill: c.ink,
        opacity: 0.5,
      }),
    );
  });
  // Header: a small red label square, FOUR FRAMES, the year, one hairline.
  const left = COLLECTION.photo.x;
  const right = left + COLLECTION.photo.width;
  body.push(`<rect x="${left}" y="64" width="9" height="9" fill="${c.accent}"/>`);
  body.push(
    text(FONTS.mono, "FOUR FRAMES", { x: left + 19, y: 74, size: 14, tracking: 0.24, fill: c.ink }),
  );
  body.push(
    text(FONTS.mono, "2026", {
      x: right,
      y: 74,
      size: 14,
      tracking: 0.24,
      align: "right",
      fill: c.ink,
    }),
  );
  body.push(`<path d="M${left} 94H${right}" stroke="${c.ink}" stroke-width="0.6" opacity="0.4"/>`);
  // Under the lockup: one more hairline, closing the sheet.
  body.push(
    `<path d="M${left} 1740H${right}" stroke="${c.ink}" stroke-width="0.6" opacity="0.4"/>`,
  );
  return svg("STUDIO SHALOM · Four Frames (art)", body);
}

// ── 04 · Jeju winter ────────────────────────────────────────────────────────────────────────
/** A soft wave line across [x0, x1] at `y`. */
function wave(x0, x1, y, amp, period, phase) {
  let d = `M${x0} ${r2(y + Math.sin(phase) * amp)}`;
  for (let x = x0 + 4; x <= x1; x += 4) {
    d += `L${x} ${r2(y + Math.sin(phase + ((x - x0) / period) * Math.PI * 2) * amp)}`;
  }
  return d;
}

function jeju() {
  const c = COLLECTION_PALETTES["jeju-winter"];
  const body = [`<rect width="${W}" height="${H}" fill="${c.paper}"/>`];
  // A light fall of snow in the margins.
  // Kept off the lettering, the postmark and the lockup, and inside the border.
  body.push(
    specks(401, 90, {
      color: c.speck,
      rMin: 0.8,
      rMax: 1.8,
      oMin: 0.3,
      oMax: 0.6,
      area: { x: 28, y: 28, width: W - 56, height: H - 56 },
      avoid: [
        { x: 56, y: 40, width: 300, height: 50 },
        { x: 360, y: 20, width: 200, height: 100 },
        { x: 160, y: 1596, width: 280, height: 150 },
        { x: 28, y: 1748, width: W - 56, height: 40 },
      ],
    }),
  );
  body.push(
    `<rect x="22" y="22" width="${W - 44}" height="${H - 44}" stroke="${c.speck}" stroke-width="0.75"/>`,
  );
  const left = COLLECTION.photo.x;
  body.push(
    text(FONTS.serifBold, "WINTER IN JEJU", {
      x: left,
      y: 76,
      size: 24,
      tracking: 0.3,
      fill: c.ink,
    }),
  );
  // A postmark: Hallasan's long, low shoulder and the sea, the place and the year.
  const pm = { x: 494, y: 62, r: 36 };
  body.push(
    `<circle cx="${pm.x}" cy="${pm.y}" r="${pm.r}" stroke="${c.ink}" stroke-width="1"/>`,
    `<circle cx="${pm.x}" cy="${pm.y}" r="${pm.r - 4}" stroke="${c.ink}" stroke-width="0.5"/>`,
    text(FONTS.serifBold, "JEJU", {
      x: pm.x,
      y: pm.y - 12,
      size: 11,
      tracking: 0.28,
      align: "center",
      fill: c.ink,
    }),
    `<path d="M${pm.x - 22} ${pm.y + 4}C${pm.x - 12} ${pm.y + 1} ${pm.x - 6} ${pm.y - 6} ${pm.x} ${pm.y - 6}C${pm.x + 6} ${pm.y - 6} ${pm.x + 12} ${pm.y + 1} ${pm.x + 22} ${pm.y + 4}" stroke="${c.ink}" stroke-width="0.9"/>`,
    `<path d="${wave(pm.x - 20, pm.x + 20, pm.y + 10, 1.4, 10, 0)}" stroke="${c.ink}" stroke-width="0.7"/>`,
    text(FONTS.serifBold, "2026", {
      x: pm.x,
      y: pm.y + 27,
      size: 10,
      tracking: 0.2,
      align: "center",
      fill: c.ink,
    }),
  );
  // Cancellation waves running out of the postmark.
  for (let i = 0; i < 3; i++) {
    body.push(
      `<path d="${wave(376, 450, 50 + i * 11, 2.2, 22, i * 0.9)}" stroke="${c.speck}" stroke-width="0.9"/>`,
    );
  }
  // The sea along the bottom: three quiet swells.
  const sea = [
    [1758, 2.6, 120, 0.0, 0.8],
    [1768, 2.2, 96, 1.7, 0.5],
    [1777, 1.8, 140, 3.1, 0.3],
  ];
  for (const [y, amp, period, phase, opacity] of sea) {
    body.push(
      `<path d="${wave(32, W - 32, y, amp, period, phase)}" stroke="${c.ink}" stroke-width="1.1" opacity="${opacity}"/>`,
    );
  }
  body.push(
    text(FONTS.italic, "A Moment of Peace", {
      x: W / 2,
      y: 1734,
      size: 19,
      align: "center",
      fill: c.ink,
    }),
  );
  return svg("STUDIO SHALOM · Winter in Jeju (art)", body);
}

// ── write ───────────────────────────────────────────────────────────────────────────────────
await mkdir(OUT, { recursive: true });
const files = {
  "vintage-christmas-art.svg": vintage(),
  "vintage-christmas-corners.svg": vintageCorners(),
  "peace-on-earth-art.svg": peace(),
  "analog-film-art.svg": film(),
  "jeju-winter-art.svg": jeju(),
};
for (const [id, c] of Object.entries(COLLECTION_PALETTES)) {
  files[`${id}-lockup.svg`] = lockup(c.ink, c.accent);
}
for (const [name, content] of Object.entries(files)) {
  await writeFile(path.join(OUT, name), content);
  console.log(`${name}  ${(content.length / 1024).toFixed(1)} KB`);
}
