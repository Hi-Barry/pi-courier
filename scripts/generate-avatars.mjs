#!/usr/bin/env node
/**
 * ⚠️ RETIRED v1 generator — running this overwrites the current AI-generated
 * avatar pool (assets/avatars/, made with scripts/generate-avatars-seedream.mjs)
 * with the old hand-drawn designs. Only run it deliberately to roll back.
 *
 * Generate the bundled pixel avatars (assets/avatars/*.png) — 12 generic pool
 * images + 1 dedicated management-room image. Blocky pixel style, 16×16 grid
 * rendered at 8× (128×128), zero dependencies (zlib PNG encoder below).
 *
 * All artwork here is ORIGINAL — inspired by the generic "chunky pixel" /
 * blocky aesthetic only. No Mojang/Microsoft assets, characters, logos,
 * fonts or signature textures are reproduced; palettes are our own. If you
 * swap these files for your own art, keep the filenames and the pool stays
 * drop-in compatible.
 *
 * Usage: node scripts/generate-avatars.mjs   (idempotent, rewrites the PNGs)
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "avatars");
const GRID = 16;
const SCALE = 8;
const SIZE = GRID * SCALE; // 128

// ---- tiny PNG encoder (RGBA, filter 0) -------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error("rgba buffer size mismatch");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- sprite machinery -------------------------------------------------------

function hexToRgb(hex) {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Minecraft-ish "block" backdrop: dark outer frame, light top/left inner
 *  bevel, sparse dark speckle inside — deterministic per seed. */
function backdropColor(x, y, bg, seed) {
  if (x === 0 || y === 0 || x === 15 || y === 15) return bg.dark;
  if (x === 1 || y === 1) return bg.light;
  return (x * 7 + y * 13 + seed * 31) % 9 === 0 ? bg.dark : bg.base;
}

function validateArt(art, name) {
  art.forEach((row, y) => {
    if (row.length > GRID) throw new Error(`${name} row ${y} longer than ${GRID}: "${row}"`);
  });
  if (art.length > GRID) throw new Error(`${name} has more than ${GRID} rows`);
}

function renderSprite(sprite) {
  validateArt(sprite.art, sprite.file);
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const palette = Object.fromEntries(Object.entries(sprite.colors).map(([k, v]) => [k, hexToRgb(v)]));
  for (const key of Object.keys(sprite.colors)) {
    if (key.length !== 1 || key === ".") throw new Error(`${sprite.file}: bad palette key "${key}"`);
  }
  for (let cy = 0; cy < GRID; cy++) {
    for (let cx = 0; cx < GRID; cx++) {
      const char = sprite.art[cy]?.[cx] ?? ".";
      let rgb;
      if (char === ".") rgb = backdropColor(cx, cy, sprite.bg, sprite.seed);
      else {
        rgb = palette[char];
        if (!rgb) throw new Error(`${sprite.file}: unknown char "${char}" at ${cx},${cy}`);
      }
      for (let py = 0; py < SCALE; py++) {
        for (let px = 0; px < SCALE; px++) {
          const offset = ((cy * SCALE + py) * SIZE + cx * SCALE + px) * 4;
          rgba[offset] = rgb[0];
          rgba[offset + 1] = rgb[1];
          rgba[offset + 2] = rgb[2];
          rgba[offset + 3] = 255;
        }
      }
    }
  }
  return encodePng(SIZE, SIZE, rgba);
}

// ---- the 12 pool sprites + management --------------------------------------
// '.' = backdrop block; every other char maps to a color in `colors`.
// Rows shorter than 16 are padded with '.' on the right.

const sprites = [
  {
    file: "instance-01.png",
    seed: 1,
    bg: { base: "#3a3f4a", dark: "#262a33", light: "#4d5461" },
    colors: { P: "#f6a821", p: "#c67f10" },
    art: [
      "................",
      "................",
      "................",
      "...PPPPPPPPPP...",
      "...PPPPPPPPPP...",
      "...PPPPPPPPPP...",
      "...PP....PP.....",
      "...PP....PP.....",
      "...PP....PP.....",
      "...PP....PP.....",
      "...PP....PP.....",
      "...PP....PP.....",
      "...pp....pp.....",
      "................",
      "................",
      "................",
    ],
  },
  {
    file: "instance-02.png",
    seed: 2,
    bg: { base: "#4a3a66", dark: "#33284a", light: "#5d4a7d" },
    colors: { L: "#eae4ff", l: "#bfa9e6", s: "#ffd76e" },
    art: [
      "................",
      ".s.....s......s.",
      "..............s.",
      "...LLLLLLLLLL...",
      "...LLLLLLLLLL...",
      "...LLLLLLLLLL...",
      "...LL....LL.....",
      "...LL....LL.....",
      "...LL....LL.....",
      "...LL....LL.....",
      "...LL....LL.....",
      "...LL....LL.....",
      "...ll....ll..s..",
      ".s..............",
      "................",
      "................",
    ],
  },
  {
    file: "instance-03.png",
    seed: 3,
    bg: { base: "#2e6e6a", dark: "#1f4f4c", light: "#3d8a85" },
    colors: { o: "#16403d", b: "#7fd6c9", l: "#a9e8de", w: "#f4fefe", p: "#10312e", m: "#16403d", e: "#55b3a5", a: "#d8f5ef" },
    art: [
      ".......aa.......",
      ".......oo.......",
      "..oooooooooooo..",
      "..ollllllllllo..",
      "..obbbbbbbbbbo..",
      "..obwwbbbbwwbo..",
      ".eobwpbbbbwpboe.",
      ".eobbbbbbbbbboe.",
      ".eobbbbbbbbbboe.",
      "..obmmmmmmmmbo",
      "..obbbbbbbbbbo..",
      "..oooooooooooo..",
      "................",
      "................",
      "................",
      "................",
    ],
  },
  {
    file: "instance-04.png",
    seed: 4,
    bg: { base: "#7a4423", dark: "#59301a", light: "#96582e" },
    colors: { o: "#4a2a14", b: "#f2a65a", l: "#f8c48c", p: "#3a2109", m: "#4a2a14" },
    art: [
      "..ll........ll..",
      "..ll........ll..",
      "..oooooooooooo..",
      "..ollllllllllo..",
      "..obbbbbbbbbbo..",
      "..obpbbbbbbpbo..",
      "..obpbbbbbbpbo..",
      "..obbbbbbbbbbo..",
      "..obbmmmmmmbbo..",
      "..obbbbbbbbbbo..",
      "..oooooooooooo..",
      "................",
      "................",
      "................",
      "................",
      "................",
    ],
  },
  {
    file: "instance-05.png",
    seed: 5,
    bg: { base: "#6b6f76", dark: "#4c5057", light: "#82868e" },
    colors: { o: "#1e5f73", L: "#bdf3f7", M: "#59c8dd", D: "#2f8fa8" },
    art: [
      "................",
      "................",
      "......oooo......",
      ".....oLLLoo.....",
      "....oLLMMMo.....",
      "...oLLMMMMDo....",
      "..oLLMMMMMDDo...",
      "..oLMMMMMDDDo...",
      "...oMMMMDDDo....",
      "....oMMMDDo.....",
      ".....oMDDo......",
      "......oDDo......",
      ".......oo.......",
      "................",
      "................",
      "................",
    ],
  },
  {
    file: "instance-06.png",
    seed: 6,
    bg: { base: "#2f6b33", dark: "#1f4a23", light: "#3d8442" },
    colors: { t: "#ffd76e", d: "#fff3c4", c: "#23343f", p: "#ffd76e", G: "#ffe9a8" },
    art: [
      "................",
      "................",
      ".......dd.......",
      ".......tt.......",
      ".......tt.......",
      "....pccccccp....",
      "....pccccccp....",
      ".dttpccGGccp....",
      ".dttpccGGccptttd",
      "....pccccccp...t",
      "....pccccccp...t",
      ".......tt......t",
      ".......dd......d",
      "................",
      "................",
      "................",
    ],
  },
  {
    file: "instance-07.png",
    seed: 7,
    bg: { base: "#4a4a55", dark: "#35353e", light: "#5c5c68" },
    colors: { o: "#2c2c34", b: "#c9ccd4", p: "#f0a7b8", E: "#9fe06f", P: "#23301b", n: "#e88aa0" },
    art: [
      "................",
      "..oo........oo..",
      "..opo......opo..",
      "..oppo....oppo..",
      "..oooooooooooo..",
      "..obbbbbbbbbbo..",
      "..obbbbbbbbbbo..",
      "..obEEbbbbEEbo..",
      "..obEPbbbbEPbo..",
      "..obbbbbbbbbbo..",
      "..obbbnnbbbbo...",
      "..obbbbbbbbbbo..",
      "..obbbbbbbbbbo..",
      "..oooooooooooo..",
      "................",
      "................",
    ],
  },
  {
    file: "instance-08.png",
    seed: 8,
    bg: { base: "#5a4632", dark: "#40321f", light: "#6f5840" },
    colors: { o: "#33261a", b: "#a9793f", w: "#f7f3e8", p: "#2b1d10", n: "#f0a03c", f: "#c79459" },
    art: [
      "................",
      ".o............o.",
      ".oo..........oo.",
      "..oooooooooooo..",
      "..owwwbbbbwwwo..",
      "..owpwbbbbwpwo..",
      "..owwwbbbbwwwo..",
      "..obbbbnnbbbbo..",
      "..obbbbbbbbbbo..",
      "..obfbbbbfbbbo..",
      "..obbbbbbbbbbo..",
      "..obfbbbbfbbbo..",
      "..oooooooooooo..",
      "...nn......nn...",
      "................",
      "................",
    ],
  },
  {
    file: "instance-09.png",
    seed: 9,
    bg: { base: "#232a4a", dark: "#171c33", light: "#2f3860" },
    colors: { r: "#e05252", R: "#b03a3a", w: "#f2f4f8", c: "#8fd8e8", f: "#ffb347", y: "#ffe08a", s: "#cfd6f0" },
    art: [
      "................",
      ".......rr.....s.",
      "..s...rrrr......",
      "......wwww......",
      "......wccw....s.",
      "......wccw......",
      "......wwww......",
      "......wwww......",
      "......wwww......",
      "..RR..wwww..RR..",
      "..RRr.wwww.rRR..",
      "....rrwwwwrr....",
      "..s....ff.......",
      ".......yy.......",
      "................",
      "................",
    ],
  },
  {
    file: "instance-10.png",
    seed: 10,
    bg: { base: "#6d5140", dark: "#4f3a2d", light: "#836552" },
    colors: { g: "#6fc26f", d: "#4a9e4a", p: "#e08a5f", P: "#c96f4a", q: "#a3532f", o: "#7a3f22" },
    art: [
      "................",
      "................",
      "..ggg......ggg..",
      ".ggggg....ggggg.",
      ".gggggg..gggggg.",
      "..gggggddggggg..",
      ".......gg.......",
      ".......gg.......",
      ".......gg.......",
      "...pppppppppp...",
      "...PPPPPPPPPq...",
      "...PPPPPPPPPq...",
      "....PPPPPPqq....",
      ".....oooooo.....",
      "................",
      "................",
    ],
  },
  {
    file: "instance-11.png",
    seed: 11,
    bg: { base: "#3a4150", dark: "#282e3a", light: "#4a5263" },
    colors: { o: "#1f242e", S: "#0d1f16", G: "#7ee787", B: "#8a93a5", b: "#6a7284" },
    art: [
      "................",
      "................",
      ".oooooooooooooo.",
      ".oSSSSSSSSSSSSo.",
      ".oSGGGGSSSSSSSo.",
      ".oSSSSSSSSSSSSo.",
      ".oSGGSSSSSSSSSo.",
      ".oSSSSSSGGSSSSo.",
      ".oSSSSSSSSSSSSo.",
      ".oooooooooooooo.",
      ".oooooooooooooo.",
      ".obBBBBBBBBBBbo.",
      "................",
      "................",
      "................",
      "................",
    ],
  },
  {
    file: "instance-12.png",
    seed: 12,
    bg: { base: "#8a3a3a", dark: "#672a2a", light: "#a34a4a" },
    colors: { o: "#3a3430", w: "#f7f4ec", p: "#2f2b28" },
    art: [
      "................",
      "................",
      "..oooooooooo....",
      "..owwwwwwwwwo...",
      "..owppwwwwppwo..",
      "..owppwwwwppwo..",
      "..owwwwwwwwwo...",
      "..owwwwppwwwwo..",
      "..owwwwppwwwwo..",
      "..owwwwwwwwwo...",
      "..owppwwwwppwo..",
      "..owppwwwwppwo..",
      "..owwwwwwwwwo...",
      "..oooooooooo....",
      "................",
      "................",
    ],
  },
  {
    file: "management.png",
    seed: 13,
    bg: { base: "#2c3350", dark: "#1f2440", light: "#3a4266" },
    colors: { g: "#ffd45e", d: "#d9a92e", R: "#e05252", C: "#59c8dd" },
    art: [
      "................",
      "................",
      "................",
      "................",
      "..g...gg...g....",
      "..gg..gg..gg....",
      ".gggg.gg.gg.ggg.",
      ".gggggggggggggg.",
      ".gRgCggRgCggRgg.",
      ".gggggggggggggg.",
      ".dddddddddddddd.",
      "................",
      "................",
      "................",
      "................",
      "................",
    ],
  },
];

// ---- run --------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });
for (const sprite of sprites) {
  const png = renderSprite(sprite);
  writeFileSync(join(OUT_DIR, sprite.file), png);
  console.log(`✔ ${sprite.file} (${png.length} bytes)`);
}
console.log(`\n${sprites.length} avatars written to ${OUT_DIR}`);
