#!/usr/bin/env node
/**
 * Generate animal-avatar drafts via OpenRouter /api/v1/images (seedream-4.5).
 *
 * Human-in-the-loop tool — candidates land in assets/avatars-drafts/ for
 * review; winners are copied over the same-named file in assets/avatars/ by
 * hand. Contract per avatar (user-approved template): perfectly symmetrical
 * front-facing animal HEAD only, cut off at the chin, face filling the frame,
 * sharp hard pixel edges (no anti-aliasing), solid background, tiny π letter
 * in the extreme bottom-left corner, 8-bit retro game avatar style.
 *
 * Usage:
 *   export OPENROUTER_API_KEY=sk-or-...   (or configure OpenRouter in ~/.zcode)
 *   node scripts/generate-avatars-seedream.mjs                # all 13
 *   node scripts/generate-avatars-seedream.mjs --only instance-01
 *
 * Env: OPENROUTER_API_KEY, optional OPENROUTER_IMAGE_MODEL (default
 * bytedance-seed/seedream-4.5).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "assets", "avatars-drafts");
const API = "https://openrouter.ai/api/v1/images";
const MODEL = process.env.OPENROUTER_IMAGE_MODEL || "bytedance-seed/seedream-4.5";

/** Per-animal subject line; the rest of the constraint frame is fixed. */
const ANIMALS = [
  { name: "instance-01", subject: "an orange tabby cat's head", accent: "vibrant orange fur, symmetrical green eyes" },
  { name: "instance-02", subject: "a penguin's head", accent: "black and white plumage, symmetrical round eyes, small orange beak" },
  { name: "instance-03", subject: "a red fox's head", accent: "rust-orange fur, white muzzle, symmetrical amber eyes, pointed ears with dark tips" },
  { name: "instance-04", subject: "a brown owl's head", accent: "brown feather pattern, big symmetrical round eyes, small sharp beak" },
  { name: "instance-05", subject: "a white rabbit's head", accent: "soft white fur, long upright ears with pink inner side, symmetrical pink eyes" },
  { name: "instance-06", subject: "a shiba inu dog's head", accent: "cream and orange fur, symmetrical happy squinting eyes" },
  { name: "instance-07", subject: "a gray cat's head", accent: "blue-gray fur, symmetrical yellow eyes, unimused half-lidded look" },
  { name: "instance-08", subject: "a brown bear cub's head", accent: "round fluffy brown fur, small rounded ears, symmetrical sleepy eyes" },
  { name: "instance-09", subject: "a giant panda's head", accent: "white and black fur, black eye patches, symmetrical curious eyes" },
  { name: "instance-10", subject: "a green frog's head", accent: "green skin, two bumps on top, symmetrical sleepy half-lidded eyes, wide closed mouth" },
  { name: "instance-11", subject: "a red squirrel's head", accent: "russet fur, tufted ears, symmetrical bright excited eyes" },
  { name: "instance-12", subject: "a yellow chick's head", accent: "fluffy yellow, tiny orange beak, symmetrical wide worried eyes" },
  { name: "management", subject: "an orange cat's head wearing a small golden crown", accent: "vibrant orange fur, symmetrical smug green eyes, tiny golden crown between the ears" },
];

const promptFor = (a) =>
  `A flat 2D pixel art icon of ${a.subject}, perfectly symmetrical front-facing view, looking directly ` +
  `at the viewer, eyes centered and staring straight ahead. Full frontal face. Head only, no neck, no body, ` +
  `no chest. Face filling the entire frame, cut off exactly at the chin. ${a.accent}. ` +
  `Sharp, crisp hard pixel edges, no anti-aliasing, isolated on a pure white solid background. ` +
  `A small white Greek letter 'π' placed strictly in the extreme bottom left corner, not overlapping the face. ` +
  `8-bit retro game avatar style.`;

// 负面提示词:封杀侧脸、偏头、透视、3D、身体与模糊(用户提供的定稿,全动物通用)
const NEGATIVE =
  "3D, realistic, side profile, three-quarter view, perspective, angle, rotation, tilt, tilted head, " +
  "looking away, body, chest, neck, shoulders, torso, blurry, fuzzy edges, soft, smooth, blending, " +
  "gradient, shadows, depth, watermark, text box, logo background, overlapping, low quality, distorted";

// ---- key --------------------------------------------------------------------

function apiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".zcode", "v2", "config.json"), "utf8"));
    for (const p of Object.values(cfg.provider ?? {})) {
      const opts = p.options ?? {};
      if (String(opts.baseURL ?? "").includes("openrouter.ai") && opts.apiKey) return opts.apiKey;
    }
  } catch {
    // fall through
  }
  console.error("缺少 OPENROUTER_API_KEY(或 ~/.zcode 里配置 OpenRouter provider)");
  process.exit(1);
}

// ---- API --------------------------------------------------------------------

async function generateImage(key, prompt) {
  const res = await fetch(API, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt, negative_prompt: NEGATIVE }),
    signal: AbortSignal.timeout(180_000), // 挂起的连接最多等 3 分钟,失败进重试
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 250)}`);
  const data = await res.json();
  const item = data?.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, "base64");
  if (item?.url) {
    const img = await fetch(item.url);
    if (!img.ok) throw new Error(`图片下载失败: HTTP ${img.status}`);
    return Buffer.from(await img.arrayBuffer());
  }
  throw new Error(`响应无图: ${JSON.stringify(data).slice(0, 200)}`);
}

// ---- post-process -----------------------------------------------------------

function hasFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function toAvatar128(rawPath, outPath) {
  execFileSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-i", rawPath, "-vf", "scale=128:128:flags=neighbor", outPath],
    { stdio: "ignore" }
  );
}

// ---- run --------------------------------------------------------------------

const only = (() => {
  const flag = process.argv.findIndex((a) => a === "--only" || a.startsWith("--only="));
  if (flag === -1) return null;
  const value = process.argv[flag].startsWith("--only=") ? process.argv[flag].slice(7) : process.argv[flag + 1] ?? "";
  return value.split(",").filter(Boolean);
})();

const targets = only ? ANIMALS.filter((a) => only.includes(a.name)) : ANIMALS;
const missing = only?.filter((n) => !ANIMALS.some((a) => a.name === n));
if (missing?.length) {
  console.error(`未知头像名: ${missing.join(",")}(可选: ${ANIMALS.map((a) => a.name).join(" ")})`);
  process.exit(1);
}

const key = apiKey();
mkdirSync(OUT_DIR, { recursive: true });
const useFfmpeg = hasFfmpeg();

let ok = 0;
for (const avatar of targets) {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const bytes = await generateImage(key, promptFor(avatar));
      const rawPath = join(OUT_DIR, `${avatar.name}-seedream-raw.png`);
      writeFileSync(rawPath, bytes);
      let note = "仅原图";
      if (useFfmpeg) {
        const outPath = join(OUT_DIR, `${avatar.name}-seedream.png`);
        toAvatar128(rawPath, outPath);
        note = "128×128";
      }
      console.log(`✔ ${avatar.name}(${(bytes.length / 1024).toFixed(0)} KB)→ ${note}`);
      ok++;
      break;
    } catch (err) {
      console.warn(`✗ ${avatar.name} 第 ${attempt}/${attempts} 次失败: ${err.message ?? err}`);
      if (attempt === attempts) console.error(`✗✗ ${avatar.name} 放弃,可 --only=${avatar.name} 重试`);
      else await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
console.log(`\n完成 ${ok}/${targets.length} → ${OUT_DIR}`);
