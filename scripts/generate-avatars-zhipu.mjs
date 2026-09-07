#!/usr/bin/env node
/**
 * Generate animal-avatar drafts via 智谱 CogView-3-Flash (free tier).
 *
 * Human-in-the-loop tool: writes candidates to assets/avatars-drafts/ for
 * review; winners are copied over the same-named file in assets/avatars/ by
 * hand (runtime pool contract: same filename, drop-in replacement). Nothing
 * here runs at pi-courier runtime and no key is shipped.
 *
 * Pipeline per avatar: CogView (Minecraft-style chunky pixel animal, ~90% of
 * canvas, one distinct expression each) → ffmpeg crop of the right strip
 * (CogView keeps painting garbled mini-text at the bottom-right edge) →
 * 128×128 nearest-neighbour → drawtext amber π signature in the bottom-left
 * (DejaVu Sans Bold; the text-model renders the glyph far better than image
 * models do at tiny sizes).
 *
 * Usage:
 *   node scripts/generate-avatars-zhipu.mjs               # all 13
 *   node scripts/generate-avatars-zhipu.mjs --only instance-02,management
 *   node scripts/generate-avatars-zhipu.mjs --only instance-05   # either syntax
 *
 * Key resolution: env ZHIPU_API_KEY, else the Bigmodel/GLM provider entry in
 * ~/.zcode/v2/config.json (local convenience — never printed, never shipped).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "assets", "avatars-drafts");
const API = "https://open.bigmodel.cn/api/paas/v4/images/generations";
const MODEL = process.env.ZHIPU_IMAGE_MODEL || "cogview-3-flash"; // free tier
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

const STYLE =
  "像游戏皮肤一样的大块平涂像素,整个画面就像低分辨率像素图被放大了很多倍,每个方块颗粒都清晰可见," +
  "只用少数几种颜色平涂,没有渐变没有细腻阴影,边缘是锯齿方块";

const ANIMALS = [
  { name: "instance-01", subject: "橘色小猫", look: "大头圆润,咧嘴大笑吐着舌头,表情夸张开心", bg: "深蓝灰色" },
  { name: "instance-02", subject: "企鹅", look: "圆滚滚,呆萌好奇地张着小嘴", bg: "淡紫色" },
  { name: "instance-03", subject: "狐狸", look: "尖耳朵大尾巴,狡黠地眯眼微笑", bg: "薄荷绿色" },
  { name: "instance-04", subject: "猫头鹰", look: "圆眼睛一丝不苟的严肃表情", bg: "暖橙红色" },
  { name: "instance-05", subject: "白兔", look: "长耳朵,害羞脸红", bg: "深绿色" },
  { name: "instance-06", subject: "柴犬", look: "卷尾巴,经典的眯眼狗子微笑", bg: "雾蓝色" },
  { name: "instance-07", subject: "灰色猫咪", look: "斜眼傲慢嫌弃的表情", bg: "暖米色" },
  { name: "instance-08", subject: "小棕熊", look: "圆耳朵,困倦地打哈欠", bg: "青绿色" },
  { name: "instance-09", subject: "熊猫", look: "黑眼圈,惊讶地张大嘴", bg: "天蓝色" },
  { name: "instance-10", subject: "青蛙", look: "大嘴巴闭着微微上扬,慵懒地半睁着眼,看不到牙齿", bg: "浅粉色" },
  { name: "instance-11", subject: "松鼠", look: "大尾巴,兴奋地睁大眼睛抱着一颗松果", bg: "淡黄色" },
  { name: "instance-12", subject: "小鸡", look: "圆圆的黄色身子橙色小嘴,惊慌地张开小翅膀,只有黄白橙三色,配色简单干净", bg: "纯靛蓝色,没有任何景物" },
  { name: "management", subject: "头顶戴着小小金色皇冠的橘猫", look: "得意的表情", bg: "深紫红色" },
];

const promptFor = (a) =>
  `我的世界游戏生物那样的超粗大方块像素画:一只${a.subject},${a.look},${STYLE};` +
  `${a.subject}极其大,占据画面约九成,头顶和脚几乎贴到画布边缘,只留很窄的${a.bg}纯色背景边;` +
  "整张图没有任何文字、字母或水印";

// ---- key --------------------------------------------------------------------

function apiKey() {
  if (process.env.ZHIPU_API_KEY) return process.env.ZHIPU_API_KEY;
  try {
    const cfgPath = join(homedir(), ".zcode", "v2", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    for (const p of Object.values(cfg.provider ?? {})) {
      const opts = p.options ?? {};
      if (String(opts.baseURL ?? "").includes("open.bigmodel.cn") && opts.apiKey) return opts.apiKey;
    }
  } catch {
    // fall through to the error below
  }
  console.error("缺少智谱 API key:设 ZHIPU_API_KEY,或在 ~/.zcode/v2/config.json 配置 Bigmodel/GLM provider");
  process.exit(1);
}

// ---- CogView call -----------------------------------------------------------

async function generateImage(key, prompt) {
  const res = await fetch(API, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, size: "1024x1024", prompt }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const item = data?.data?.[0];
  if (!item) throw new Error(`响应无图: ${JSON.stringify(data).slice(0, 200)}`);
  if (item.b64_json) return Buffer.from(item.b64_json, "base64");
  if (item.url) {
    const img = await fetch(item.url);
    if (!img.ok) throw new Error(`图片下载失败: HTTP ${img.status}`);
    return Buffer.from(await img.arrayBuffer());
  }
  throw new Error("响应既无 url 也无 b64_json");
}

// ---- ffmpeg pipeline --------------------------------------------------------

function ffmpeg(args, quiet = true) {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: quiet ? "ignore" : "inherit" });
}

/** Right strip crop kills CogView's garbled corner text, then 128×128
 *  nearest-neighbour keeps the blocks chunky. */
function toAvatar128(rawPath, outPath) {
  ffmpeg(["-i", rawPath, "-vf", "crop=920:1024:0:0,scale=128:128:flags=neighbor", outPath]);
}

function stampPi(outPath) {
  if (!existsSync(FONT)) {
    console.warn(`⚠ 未找到 ${FONT},跳过 π 签名(仅此一张)`);
    return false;
  }
  ffmpeg([
    "-i", outPath,
    "-vf",
    `drawtext=textfile=${join(OUT_DIR, ".pi.txt")}:fontfile=${FONT}:fontsize=17:fontcolor=0xF6A821:x=8:y=128-th-8`,
    join(OUT_DIR, ".tmp.png"),
  ]);
  execFileSync("mv", [join(OUT_DIR, ".tmp.png"), outPath]);
  return true;
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
writeFileSync(join(OUT_DIR, ".pi.txt"), "π");

let ok = 0;
for (const avatar of targets) {
  const prompt = promptFor(avatar);
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const bytes = await generateImage(key, prompt);
      const rawPath = join(OUT_DIR, `${avatar.name}-raw.png`);
      writeFileSync(rawPath, bytes);
      const outPath = join(OUT_DIR, `${avatar.name}.png`);
      toAvatar128(rawPath, outPath);
      const stamped = stampPi(outPath);
      console.log(`✔ ${avatar.name}(${avatar.subject},${(bytes.length / 1024).toFixed(0)} KB)${stamped ? " +π" : ""}`);
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
