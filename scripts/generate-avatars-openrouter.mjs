#!/usr/bin/env node
/**
 * Generate avatar drafts via OpenRouter text-to-image (bytedance-seed/seedream-4.5).
 *
 * NOT part of the runtime — this is a human-in-the-loop tool: it writes
 * candidates to assets/avatars-drafts/ for review; winners get copied over
 * the same-named file in assets/avatars/ by hand (the runtime pool contract:
 * same filename, drop-in replacement).
 *
 * Usage:
 *   export OPENROUTER_API_KEY=sk-or-...        # required
 *   node scripts/generate-avatars-openrouter.mjs               # all 13
 *   node scripts/generate-avatars-openrouter.mjs --only instance-01,management
 *
 * Env:
 *   OPENROUTER_API_KEY   (required) OpenRouter key
 *   OPENROUTER_MODEL     (optional) default: google/gemini-2.5-flash-image
 *
 * Raw model output is kept as <name>-raw.<ext>; a 128×128 nearest-neighbour
 * resize (ffmpeg, pixel-crisp) lands at <name>.png when ffmpeg is available.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "assets", "avatars-drafts");
const MODEL = process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash-image";
const API = "https://openrouter.ai/api/v1/chat/completions";

const STYLE =
  "Pixel art avatar icon, chunky blocky pixels, flat solid-color background, single subject, " +
  "centered composition, clean silhouette, original artwork — must not resemble any existing " +
  "game character, mob, logo or texture. Square format, no text, no watermark.";

const AVATARS = [
  {
    name: "instance-01",
    prompt:
      "A small amber-orange Greek letter π (pi) glyph placed in the BOTTOM-LEFT quarter of the canvas, " +
      "occupying only about a quarter of the canvas area, on a dark slate-blue block background; " +
      "the other three quarters stay mostly empty with a few subtle dim dots and a small plus mark as decoration. " + STYLE,
  },
  {
    name: "instance-02",
    prompt:
      "A small pale-lavender Greek letter π (pi) glyph placed in the BOTTOM-LEFT quarter of the canvas, " +
      "occupying only about a quarter of the canvas area, on a deep purple block background with a few " +
      "tiny gold star sparkles scattered in the empty areas. " + STYLE,
  },
  { name: "instance-03", prompt: "A cute friendly robot head, teal/cyan tones, dark outline, square eyes and a small antenna. " + STYLE },
  { name: "instance-04", prompt: "A cute friendly robot head, warm orange tones, dark outline, vertical slit eyes and two small horns. " + STYLE },
  { name: "instance-05", prompt: "A shining cyan gem crystal on a gray stone block background. " + STYLE },
  { name: "instance-06", prompt: "A green circuit board with golden traces, solder dots and a central dark chip. " + STYLE },
  { name: "instance-07", prompt: "A gray cat face with pink inner ears and green eyes. " + STYLE },
  { name: "instance-08", prompt: "A brown owl face with big square white eyes, orange beak and ear tufts. " + STYLE },
  { name: "instance-09", prompt: "A small red-and-white rocket flying diagonally on a dark navy starry night background. " + STYLE },
  { name: "instance-10", prompt: "A young green sprout with two leaves in a terracotta flower pot. " + STYLE },
  { name: "instance-11", prompt: "A dark laptop with a glowing green command-line cursor on its screen. " + STYLE },
  { name: "instance-12", prompt: "A white six-sided die showing the five-face, on a red block background. " + STYLE },
  { name: "management", prompt: "A golden crown with red and cyan jewels on a dark navy block background. " + STYLE },
];

// ---- OpenRouter call --------------------------------------------------------

function apiKey() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    console.error("缺少 OPENROUTER_API_KEY 环境变量(OpenRouter 的 sk-or-... token)");
    process.exit(1);
  }
  return key;
}

async function generateImage(key, prompt) {
  const res = await fetch(API, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      modalities: ["image", "text"],
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const message = data?.choices?.[0]?.message;
  const entry = message?.images?.[0];
  const url = entry?.image_url?.url ?? entry?.url;
  if (!url) {
    const text = typeof message?.content === "string" ? message.content : JSON.stringify(message)?.slice(0, 300);
    throw new Error(`响应中没有图片;模型文本:${text ?? "(空)"}`);
  }
  const match = /^data:([^;]+);base64,(.+)$/s.exec(url);
  if (!match) throw new Error(`图片不是 base64 data URL: ${String(url).slice(0, 80)}...`);
  return { mime: match[1], bytes: Buffer.from(match[2], "base64") };
}

// ---- ffmpeg post-process ----------------------------------------------------

function hasFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Nearest-neighbour resize to 128×128 — keeps the blocky look crisp and the
 *  file tiny. Falls back to the raw bytes when ffmpeg is unavailable. */
function toAvatar128(rawPath, outPath) {
  try {
    execFileSync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-i", rawPath, "-vf", "scale=128:128:flags=neighbor", outPath],
      { stdio: "ignore" }
    );
    return true;
  } catch {
    return false;
  }
}

// ---- run --------------------------------------------------------------------

const only = (() => {
  const flag = process.argv.findIndex((a) => a === "--only" || a.startsWith("--only="));
  if (flag === -1) return null;
  const value = process.argv[flag].startsWith("--only=")
    ? process.argv[flag].slice(7)
    : process.argv[flag + 1] ?? "";
  return value.split(",").filter(Boolean);
})();

const key = apiKey();
mkdirSync(OUT_DIR, { recursive: true });
const useFfmpeg = hasFfmpeg();
if (!useFfmpeg) console.log("⚠ 未找到 ffmpeg,保留原始大图,不做 128×128 缩放");

const targets = only ? AVATARS.filter((a) => only.includes(a.name)) : AVATARS;
const missing = only?.filter((n) => !AVATARS.some((a) => a.name === n));
if (missing?.length) {
  console.error(`未知头像名: ${missing.join(",")}(可选: ${AVATARS.map((a) => a.name).join(" ")})`);
  process.exit(1);
}

let ok = 0;
for (const avatar of targets) {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { mime, bytes } = await generateImage(key, avatar.prompt);
      const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
      const rawPath = join(OUT_DIR, `${avatar.name}-raw.${ext}`);
      writeFileSync(rawPath, bytes);
      const outPath = join(OUT_DIR, `${avatar.name}.png`);
      const resized = useFfmpeg && toAvatar128(rawPath, outPath) && existsSync(outPath);
      console.log(`✔ ${avatar.name}(${mime}, ${(bytes.length / 1024).toFixed(0)} KB)→ ${resized ? "128×128" : "仅原图"}`);
      ok++;
      break;
    } catch (err) {
      console.warn(`✗ ${avatar.name} 第 ${attempt}/${attempts} 次失败: ${err.message ?? err}`);
      if (attempt === attempts) console.error(`✗✗ ${avatar.name} 放弃,可稍后 --only=${avatar.name} 重试`);
      else await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
console.log(`\n完成 ${ok}/${targets.length} → ${OUT_DIR}`);
