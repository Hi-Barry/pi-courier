#!/usr/bin/env node
/**
 * 头像池 v3 —— 棉花糖软萌高清风(2026-09-11 定稿提示词)。
 *
 * 推翻 v1/v2 的像素风:每只小动物 = 棉花糖+翻糖质感圆脑袋、真实小奶猫式眼睛
 * (非玻璃珠)、爱心糖鼻子、闭嘴 ω 笑、粉扑腮红,背景是粉紫青三色棉花糖云。
 * 提示词经 6 轮人工审定收敛(v9 橘猫稿获用户认可),本脚本将其固化为模板:
 * 固定"画框" + 每只动物的 subject/nose/eyes/accent 插槽。
 *
 * 输出:assets/avatars-drafts/candy-pool/<name>.png(实际多为 JPEG,先落草稿)
 * 审定后用 --ship 把选中稿转成 512×512 真 PNG 写入 assets/avatars/。
 *
 * 用法:
 *   node scripts/generate-avatars-candy.mjs                 # 全量 13 张
 *   node scripts/generate-avatars-candy.mjs --only=instance-03,management
 *   node scripts/generate-avatars-candy.mjs --ship          # 草稿 → 正式 512 PNG
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRAFT_DIR = join(ROOT, "assets", "avatars-drafts", "candy-pool");
const SHIP_DIR = join(ROOT, "assets", "avatars");
const API = "https://openrouter.ai/api/v1/images";
const MODEL = process.env.OPENROUTER_IMAGE_MODEL || "bytedance-seed/seedream-4.5";
const SHIP_SIZE = 512;

/** 画框默认头型描述。尖耳动物够用;圆头/无耳动物(企鹅、猫头鹰、熊、青蛙、小鸡)
 *  实测会被模型理解成"方形糖块贴脸",必须用 head 插槽显式要"完整圆球头"。 */
const DEFAULT_HEAD = "A single soft rounded head silhouette, like a plush round marshmallow puff.";
const BALL_HEAD =
  "The whole head is one perfectly round ball of marshmallow — a complete soft sphere, " +
  "like a round plush ball, with the face features sitting directly on the ball.";

/** 每只动物的插槽内容;画框(风格/构图/背景)对所有动物一致。 */
const ANIMALS = [
  {
    name: "instance-01",
    subject: "an orange tabby cat's head",
    texture: "powdery matte pastel-orange fur with darker orange tabby stripes",
    nose: "a soft pink candy heart nose",
    eyes: "warm amber-green iris with a vertical slit pupil",
    accent: "Small triangular ears with pink fondant inner ears.",
  },
  {
    name: "instance-02",
    subject: "a penguin's head",
    head: BALL_HEAD,
    texture: "powdery matte black-and-white fondant feathers",
    nose: "a small glossy orange candy beak",
    eyes: "round dark brown iris with a round pupil",
    accent: "A patch of white fondant feathers framing the face, black cap on top.",
  },
  {
    name: "instance-03",
    subject: "a red fox's head",
    texture: "powdery matte rust-orange fur with a white fondant muzzle",
    nose: "a tiny black candy nose",
    eyes: "warm amber iris with a vertical slit pupil",
    accent: "Tall pointed ears with dark chocolate-brown fondant tips.",
  },
  {
    name: "instance-04",
    subject: "a brown owl's head",
    head: BALL_HEAD,
    texture: "powdery matte soft-brown fondant feathers with fine speckles",
    nose: "a small sharp caramel candy beak",
    eyes: "big round golden-amber iris with a round pupil",
    accent: "A pale heart-shaped facial disc, tiny feather tufts above the eyes. Only the head — nothing below the chin.",
  },
  {
    name: "instance-05",
    subject: "a white rabbit's head",
    texture: "powdery matte snow-white fur with a dusting of powdered sugar",
    nose: "a soft pink candy heart nose",
    eyes: "round rose-brown iris with a round pupil",
    accent: "Two long upright ears with pink fondant inner ears.",
  },
  {
    name: "instance-06",
    subject: "a shiba inu dog's head",
    texture: "powdery matte cream-and-orange fur",
    nose: "a small black candy nose",
    eyes: "warm dark brown iris with a round pupil",
    accent: "Perky triangular ears, white fondant muzzle and cheeks.",
  },
  {
    name: "instance-07",
    subject: "a gray cat's head",
    texture: "powdery matte blue-gray fur",
    nose: "a soft pink candy heart nose",
    eyes: "yellow-green iris with a vertical slit pupil",
    accent: "Wide triangular ears with pale pink inner ears, faint darker stripes.",
  },
  {
    name: "instance-08",
    subject: "a brown bear cub's head",
    texture: "powdery matte milk-chocolate-brown fur",
    nose: "a big soft brown candy nose",
    eyes: "round dark honey-brown iris with a round pupil",
    accent: "Small round fondant ears with caramel centers.",
  },
  {
    name: "instance-09",
    subject: "a giant panda's head",
    texture: "powdery matte white fur with black fondant eye patches and ears",
    nose: "a small black candy nose",
    eyes: "round dark brown iris with a round pupil",
    accent: "Round black fondant ears, classic black eye patches around the eyes.",
  },
  {
    name: "instance-10",
    subject: "a green frog's head",
    head: BALL_HEAD,
    texture: "powdery matte pastel-green fondant skin with tiny sugar dots",
    nose: "two tiny nostril dots",
    eyes: "round golden iris with a vertical slit pupil, both eyes wide open looking at the viewer",
    accent: "Two soft bumps on top of the head where the eyes sit, wide cheerful closed mouth line.",
  },
  {
    name: "instance-11",
    subject: "a red squirrel's head",
    texture: "powdery matte russet-orange fur with a cream muzzle",
    nose: "a tiny pink candy nose",
    eyes: "round bright dark-brown iris with a round pupil",
    accent: "Big fluffy ears with cream tufts, cheeky alert look.",
  },
  {
    name: "instance-12",
    subject: "a yellow chick's head",
    head: BALL_HEAD,
    texture: "powdery matte butter-yellow fondant fluff",
    nose: "a tiny glossy orange candy beak",
    eyes: "round dark brown iris with a round pupil",
    mouth: "no mouth line at all — the little beak is closed and is the only mouth",
    accent: "A small tuft of fluff on top of the head.",
  },
  {
    name: "management",
    subject: "an orange tabby cat's head wearing a small golden candy crown",
    texture: "powdery matte pastel-orange fur with darker orange tabby stripes",
    nose: "a soft pink candy heart nose",
    eyes: "warm amber-green iris with a vertical slit pupil",
    accent:
      "A tiny glossy golden candy crown with three points and a sugar gem sits between the ears; small triangular ears with pink fondant inner ears.",
  },
];

/** 定稿画框(v9 模板):除插槽外逐字保留,改动需重新人工审定。 */
const promptFor = (a) =>
  `A high-definition soft candy avatar of ${a.subject}, perfectly symmetrical front-facing view, ` +
  `looking directly at the viewer, head only, no body. The animal is made of fluffy marshmallow and ` +
  `sugar-dusted fondant: ${a.texture}, with a fine dusting of white powdered sugar, pillowy rounded ` +
  `cheeks, ${a.nose}, ${a.mouth ?? "a sweet shy closed-mouth smile drawn as a small 'w' line"}, round ` +
  `marshmallow blush cheeks. ${a.head ?? DEFAULT_HEAD} Natural well-proportioned cute animal face: the ` +
  `eyes are realistic young animal eyes set naturally into the plush face — soft almond-round, ` +
  `${a.eyes}, gentle natural shine with one small catchlight, smooth bare fur eyelids with no lashes, ` +
  `bright and soulful, modest in size. ${a.accent} ` +
  `Cute gentle expression. Background: a dreamy cloud of cotton candy in pastel pink, lilac and mint, ` +
  `floating sugar floss wisps, tiny sprinkles and soft glowing bokeh, airy bright pastel palette. ` +
  `Smooth polished 3D render, soft studio lighting, pastel candy colors, crisp details, centered ` +
  `square composition for a profile picture.`;

// 负面词教训:绝不写 square/blocky 之外的形状否定(写 square 反而招来方头);
// 封杀吐舌头、张嘴、大眼、玻璃珠眼、睫毛、糖棍与像素风。
const NEGATIVE =
  "eyelashes, false lashes, heavy eyeliner, makeup eyes, candy eyes, glass bead eyes, jelly eyes, " +
  "big eyes, oversized eyes, anime eyes, star glints in eyes, tongue, sticking out tongue, open mouth, " +
  "teeth, wink, winking, closed eye, sleepy eyes, lollipop stick, pixel art, pixels, blocky, low " +
  "resolution, blurry, text, watermark, logo, signature, body, neck, shoulders, extra limbs, deformed " +
  "face, scary, dark mood";

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
    body: JSON.stringify({ model: MODEL, prompt, negative_prompt: NEGATIVE, aspect_ratio: "1:1" }),
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

// ---- ship(草稿 → 正式 512×512 真 PNG) --------------------------------------

function shipDrafts(names) {
  for (const name of names) {
    const draft = join(DRAFT_DIR, `${name}.png`);
    const out = join(SHIP_DIR, `${name}.png`);
    // 高清平滑缩放用 lanczos(像素风时代的 neighbor 已退役)
    execFileSync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-i", draft, "-vf", `scale=${SHIP_SIZE}:${SHIP_SIZE}:flags=lanczos`, out],
      { stdio: "ignore" }
    );
    const magic = readFileSync(out).subarray(0, 8).toString("hex");
    if (magic !== "89504e470d0a1a0a") throw new Error(`${out} 不是真 PNG(魔数 ${magic})`);
    console.log(`✔ ${name} → ${out}(${SHIP_SIZE}×${SHIP_SIZE} PNG)`);
  }
}

// ---- run --------------------------------------------------------------------

const argv = process.argv.slice(2);
const flagValue = (prefix) => {
  const hit = argv.find((a) => a.startsWith(`${prefix}=`));
  return hit ? hit.slice(prefix.length + 1) : null;
};
const only = flagValue("--only")?.split(",").filter(Boolean) ?? null;
const targets = only ? ANIMALS.filter((a) => only.includes(a.name)) : ANIMALS;
if (only && targets.length !== only.length) {
  const known = new Set(ANIMALS.map((a) => a.name));
  console.error(`未知头像名: ${only.filter((n) => !known.has(n)).join(",")}`);
  process.exit(1);
}

if (argv.includes("--ship")) {
  shipDrafts(targets.map((a) => a.name));
  console.log(`\n出货完成 ${targets.length} 张 → ${SHIP_DIR}`);
  process.exit(0);
}

const key = apiKey();
mkdirSync(DRAFT_DIR, { recursive: true });

let ok = 0;
for (const avatar of targets) {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const bytes = await generateImage(key, promptFor(avatar));
      const outPath = join(DRAFT_DIR, `${avatar.name}.png`);
      writeFileSync(outPath, bytes);
      console.log(`✔ ${avatar.name}(${(bytes.length / 1024).toFixed(0)} KB)→ ${outPath}`);
      ok++;
      break;
    } catch (err) {
      console.warn(`✗ ${avatar.name} 第 ${attempt}/${attempts} 次失败: ${err.message ?? err}`);
      if (attempt === attempts) console.error(`✗✗ ${avatar.name} 放弃,可 --only=${avatar.name} 重试`);
      else await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
console.log(`\n完成 ${ok}/${targets.length} → ${DRAFT_DIR}`);
if (ok < targets.length) process.exit(1);
