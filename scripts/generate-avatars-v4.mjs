#!/usr/bin/env node
/**
 * 头像池 v4 —— 三套素材(spec #84):风景空间套 / 小屋房间套 / 动物 agent 套。
 *
 * v4 沿用 v3 的棉花糖软糖质感基底,靠主题+配色区分三套:空间=冷色自然风景、
 * 项目房间=暖色童话小屋(管理房间=金顶城堡专属)、bot 账号头像=原有动物套。
 * 与 v3 的"统一画框+插槽"不同,v4 的 25 张提示词不是同一个模板:生成期间
 * 发现含 "avatar/profile picture" 字样的提示词会让部分场景被画成"浮在云上的
 * 圆角图标贴片"(模型把"头像"概念画进画面),修复时这些张改用了"close-up 场景"
 * 描述并把云雾压到画幅四边(见 PROMPTS 注记)。因此本脚本逐张存定稿提示词,
 * 不再做插槽模板——每张就是它出货时的原句,所见即所得。
 *
 * 踩坑(DEVLOG 2026-09-17):
 *  - 负面提示词"提及即污染":只封风格性装饰(水印/文字/像素风),构图错误
 *    一律回正面描述里给正确的形状锚点。
 *  - 场景类头像提示词禁用 "avatar"/"profile picture" 字样。
 *
 * 输出:assets/avatars-drafts/v4-pool/<name>.png(实际多为 JPEG,先落草稿)
 * 审定后用 --ship 把选中稿转成 512×512 真 PNG 写入 assets/avatars/。
 *
 * 用法:
 *   node scripts/generate-avatars-v4.mjs                 # 全量 25 张
 *   node scripts/generate-avatars-v4.mjs --only=space-03,room-11
 *   node scripts/generate-avatars-v4.mjs --ship          # 草稿 → 正式 512 PNG
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRAFT_DIR = join(ROOT, "assets", "avatars-drafts", "v4-pool");
const SHIP_DIR = join(ROOT, "assets", "avatars");
const API = "https://openrouter.ai/api/v1/images";
const MODEL = process.env.OPENROUTER_IMAGE_MODEL || "bytedance-seed/seedream-4.5";
const SHIP_SIZE = 512;

// 负面词教训:绝不写想要排除的形状/构图(提及即污染);只封风格性装饰。
const NEGATIVE =
  "text, watermark, logo, signature, pixel art, pixels, blocky, low resolution, blurry, frame, border, vignette, dark mood, scary";

/** 25 张定稿提示词(出货原句)。repaired: true 表示该张经历过"图标贴片"修复,
 *  提示词里已去掉 avatar/profile picture 字样并改用 close-up/满版构图。 */
const PROMPTS = {
  "space-01": {
    prompt:
      "A high-definition soft candy landscape avatar of a miniature snowy mountain scene under an aurora, centered square composition for a profile picture. " +
      "A cluster of small rounded snow-capped mountains made of fluffy marshmallow and sugar-dusted fondant, powdery matte white snow with a fine dusting of powdered sugar, pillowy rounded peaks. " +
      "Above them, a glowing green and lilac aurora ribbon curls across a soft deep-blue night sky like glowing sugar floss, with tiny sparkling sugar stars and soft glowing bokeh. " +
      "A few tiny pastel pine trees with frosted fondant foliage sit at the foot of the mountains. " +
      "Smooth polished 3D render, soft studio lighting, dreamy cool pastel palette of mint, lilac and ice blue, crisp details, cute airy mood, centered composition that reads clearly at small icon sizes.",
  },
  "space-02": {
    prompt:
      "A high-definition soft candy landscape avatar of a tiny tropical island in a turquoise bay, centered square composition for a profile picture. " +
      "A small rounded islet of sugar-dusted pale sand with two fluffy fondant palm trees, surrounded by clear candy-glass water in a gradient of turquoise and mint, soft sugar-foam waves, a few rounded sugar pebbles in the shallows. " +
      "Smooth polished 3D render, soft studio lighting, dreamy cool pastel palette of aqua, mint and pale blue, crisp details, cute airy mood, full-bleed edge-to-edge composition with no rounded corners and no border, reads clearly at small icon sizes.",
  },
  "space-03": {
    repaired: true,
    prompt:
      "A high-definition soft candy landscape avatar of a misty pine forest valley, full-bleed square landscape composition. " +
      "Rows of small rounded fondant pine trees in graded mint and teal greens drift into soft marshmallow fog, the sky between the treetops is completely filled with soft glowing clouds, tiny sugar stars and bokeh, a faint sugar-dust path winding between the trees. " +
      "Smooth polished 3D render, soft studio lighting, dreamy cool pastel palette of mint, teal and pale blue, crisp details, cute airy mood, the fog and clouds extend all the way to every edge of the image, reads clearly at small sizes.",
  },
  "space-04": {
    prompt:
      "A high-definition soft candy landscape avatar of rounded desert dunes at dusk, centered square composition for a profile picture. " +
      "Smooth pillowy dunes of apricot and rose sugar sand with a fine powdered-sugar shimmer, a couple of skinny rounded fondant cacti, a low glossy candy sun melting into a soft lilac-peach gradient sky with tiny bokeh stars. " +
      "Smooth polished 3D render, soft studio lighting, dreamy pastel palette of peach, rose and lilac, crisp details, cute airy mood, full-bleed edge-to-edge composition with no rounded corners and no border, reads clearly at small icon sizes.",
  },
  "space-05": {
    prompt:
      "A high-definition soft candy landscape avatar of a small waterfall cascading from rounded marshmallow cliffs, centered square composition for a profile picture. " +
      "Glossy candy-glass water falls in soft ribbons into a round pale-blue pool, sugar mist and glowing bokeh rising, pillowy cliffs dotted with mint fondant moss and tiny fondant ferns. " +
      "Smooth polished 3D render, soft studio lighting, dreamy cool pastel palette of aqua, mint and cream, crisp details, cute airy mood, full-bleed edge-to-edge composition with no rounded corners and no border, reads clearly at small icon sizes.",
  },
  "space-06": {
    prompt:
      "A high-definition soft candy landscape avatar of rolling meadow hills with a single fluffy tree, centered square composition for a profile picture. " +
      "Layers of pillowy mint-green fondant hills, one big round marshmallow tree with a puffy pastel-pink crown standing alone, tiny sugar flowers dotting the grass, soft blue sky with small cotton clouds and bokeh. " +
      "Smooth polished 3D render, soft studio lighting, dreamy fresh pastel palette of mint, pink and sky blue, crisp details, cute airy mood, full-bleed edge-to-edge composition with no rounded corners and no border, reads clearly at small icon sizes.",
  },
  "space-07": {
    prompt:
      "A high-definition soft candy landscape avatar of a frozen sugar-glass lake with small rounded icebergs, centered square composition for a profile picture. " +
      "A pale ice-blue glossy candy surface like hard candy, chunky marshmallow icebergs dusted with powdered sugar, gentle snowfall and bokeh, soft lavender horizon glow. " +
      "Smooth polished 3D render, soft studio lighting, dreamy cool pastel palette of ice blue, lavender and white, crisp details, cute airy mood, full-bleed edge-to-edge composition with no rounded corners and no border, reads clearly at small icon sizes.",
  },
  "space-08": {
    prompt:
      "A high-definition soft candy landscape avatar of a calm night lake reflecting a big full moon, centered square composition for a profile picture. " +
      "A huge soft marshmallow moon with a gentle glow above a deep periwinkle sky of tiny sugar stars, mirror-still candy-glass water doubling the moon, low rounded fondant hills on the horizon. " +
      "Smooth polished 3D render, soft studio lighting, dreamy pastel palette of periwinkle, lilac and silver, crisp details, cute airy mood, full-bleed edge-to-edge composition with no rounded corners and no border, reads clearly at small icon sizes.",
  },
  "space-09": {
    prompt:
      "A high-definition soft candy landscape avatar of a small striped candy canyon, centered square composition for a profile picture. " +
      "Layered fondant cliffs in soft bands of pastel rose, peach and cream like stacked taffy, one rounded arch opening glowing warmly, a sandy sugar floor with rounded pebbles and tiny bokeh. " +
      "Smooth polished 3D render, soft studio lighting, dreamy pastel palette of rose, peach and cream, crisp details, cute airy mood, full-bleed edge-to-edge composition with no rounded corners and no border, reads clearly at small icon sizes.",
  },
  "space-10": {
    repaired: true,
    prompt:
      "A dreamy soft candy scene of a small glowing volcano rising from a pastel island shore, close-up view. " +
      "A rounded charcoal-gray fondant volcano fills much of the frame, its rim glowing with bright coral-and-gold candy lava, glossy caramel lava ribbons trickling down one side of the slope, a soft cotton-candy smoke plume drifting toward the upper corner, tiny glowing ember bokeh floating around the peak. " +
      "Around the base, charcoal sugar-rock boulders, tiny mint fondant bushes and a pastel lavender sugar-sand beach strewn with rounded pebbles that stretches to all four edges of the image. " +
      "Dusk sky in pastel lilac and peach, completely filled with soft glowing clouds and tiny sugar stars. " +
      "Smooth polished 3D render, soft studio lighting, dreamy pastel palette of lavender, coral and mint, crisp details, cute airy mood, reads clearly at small sizes.",
  },
  "space-11": {
    repaired: true,
    prompt:
      "A high-definition soft candy landscape avatar of endless pastel flower fields in soft bloom, full-bleed square landscape composition. " +
      "Neat rounded rows of tiny fondant tulips in pink, lilac and cream on pillowy mint-green hills, one small winding sugar path, the sky above the fields is completely filled with soft morning clouds, cotton puffs and floating bokeh sparkles. " +
      "Smooth polished 3D render, soft studio lighting, dreamy fresh pastel palette of pink, lilac and mint, crisp details, cute airy mood, the clouds and flower fields extend all the way to every edge of the image, reads clearly at small sizes.",
  },
  "space-12": {
    prompt:
      "A high-definition soft candy landscape avatar of sweet peaks rising above a sea of clouds, centered square composition for a profile picture. " +
      "Three tall pillowy mountain peaks of pale violet and blue fondant rising from an ocean of fluffy marshmallow clouds glowing softly at dawn, tiny fading sugar stars above. " +
      "Smooth polished 3D render, soft studio lighting, dreamy pastel palette of violet, blue and cream, crisp details, cute airy mood, full-bleed edge-to-edge composition with no rounded corners and no border, reads clearly at small icon sizes.",
  },
  "room-01": {
    prompt:
      "A high-definition soft candy avatar of a tiny fairy-tale cottage, perfectly centered front-facing view, centered square composition for a profile picture. " +
      "A cute little house with a rounded red candy roof of glossy fondant tiles, cream marshmallow walls with a sugar-dusted matte texture, one small rounded door, tiny warmly glowing windows, a little chimney with a soft puff of cotton candy smoke. " +
      "Pillowy rounded shapes everywhere, a tiny fondant bush and a pastel path of sugar pebbles in front of the door. " +
      "Background: a dreamy cloud of cotton candy in warm pastel peach, cream and soft pink, floating sugar floss wisps, tiny sprinkles and soft glowing bokeh, airy bright pastel palette. " +
      "Smooth polished 3D render, soft studio lighting, warm candy colors, crisp details, cute cozy mood, centered composition that reads clearly at small icon sizes.",
  },
  "room-02": {
    prompt:
      "A high-definition soft candy avatar of a mushroom-shaped fairy cottage, perfectly centered front-facing view, centered square composition for a profile picture. " +
      "A big glossy red candy cap with white fondant spots as the roof, cream marshmallow stem walls, a tiny rounded wooden door with warmly glowing round windows, a sugar-pebble path and one small fondant bush. " +
      "Background: a dreamy cloud of cotton candy in warm pastel peach, cream and soft pink, floating sugar floss wisps, tiny sprinkles and soft glowing bokeh, airy bright pastel palette. " +
      "Smooth polished 3D render, soft studio lighting, warm candy colors, crisp details, cute cozy mood, full-bleed edge-to-edge composition with no rounded corners and no border, reads clearly at small icon sizes.",
  },
  "room-03": {
    prompt:
      "A high-definition soft candy avatar of a small lighthouse cottage on a rocky candy shore, perfectly centered front-facing view, centered square composition for a profile picture. " +
      "A rounded white-and-coral striped fondant tower with a warmly glowing lantern room and a little pointed candy roof, standing on a sugar-dusted rock by calm turquoise candy water with soft foam waves. " +
      "Background: a dreamy cloud of cotton candy in pastel peach and aqua, floating sugar floss wisps, tiny sprinkles and soft glowing bokeh, airy bright pastel palette. " +
      "Smooth polished 3D render, soft studio lighting, warm candy colors, crisp details, cute cozy mood, full-bleed edge-to-edge composition with no rounded corners and no border, reads clearly at small icon sizes.",
  },
  "room-04": {
    repaired: true,
    prompt:
      "A dreamy soft candy scene of a cozy treehouse cottage nestled in a big fluffy tree, close-up view. " +
      "A round wooden door and tiny warmly glowing windows set into the marshmallow trunk, a puffy pastel-green fondant canopy with tiny sugar blossoms spreading across the upper corner of the image, a little ladder of sugar twine dangling down one side. " +
      "Drifts of cotton-candy clouds in pastel peach and mint float in front of the lower edge of the tree and stretch beyond all four edges of the image, with floating sugar floss wisps, tiny sprinkles and soft glowing bokeh. " +
      "Smooth polished 3D render, soft studio lighting, warm candy colors, crisp details, cute cozy mood, reads clearly at small sizes.",
  },
  "room-05": {
    repaired: true,
    prompt:
      "A dreamy soft candy scene of a snowy winter cabin tucked into a deep snowdrift, close-up view. " +
      "A cute rounded cottage under a thick powdered-sugar snow blanket, warmly glowing amber windows, marshmallow snow-laden fondant pines crowding one side, soft falling snow drifting across the whole scene, drifts of cotton-candy snow clouds overlapping the bottom edge and stretching beyond all four edges of the image, pastel ice-blue and cream palette with soft glowing bokeh. " +
      "Smooth polished 3D render, soft studio lighting, warm candy colors, crisp details, cute cozy mood, reads clearly at small sizes.",
  },
  "room-06": {
    prompt:
      "A high-definition soft candy avatar of a little windmill cottage, perfectly centered front-facing view, centered square composition for a profile picture. " +
      "A round cream marshmallow tower with a small glossy red candy cap and four soft sugar-blade sails, a tiny rounded door with a flower box of fondant tulips. " +
      "Background: a dreamy cloud of cotton candy in pastel peach and sky blue, cotton clouds, floating sugar floss wisps, tiny sprinkles and soft glowing bokeh, airy bright pastel palette. " +
      "Smooth polished 3D render, soft studio lighting, warm candy colors, crisp details, cute cozy mood, full-bleed edge-to-edge composition with no rounded corners and no border, reads clearly at small icon sizes.",
  },
  "room-07": {
    prompt:
      "A high-definition soft candy avatar of a cottage shaped like a giant teapot, perfectly centered front-facing view, centered square composition for a profile picture. " +
      "A rounded cream fondant teapot body with a tiny warmly glowing window, a curled candy handle and spout, a glossy pastel lid roof with a knob chimney puffing cotton-candy steam, a sugar-pebble path leading to a tiny rounded door. " +
      "Background: a dreamy cloud of cotton candy in warm pastel peach and cream, floating sugar floss wisps, tiny sprinkles and soft glowing bokeh, airy bright pastel palette. " +
      "Smooth polished 3D render, soft studio lighting, warm candy colors, crisp details, cute cozy mood, full-bleed edge-to-edge composition with no rounded corners and no border, reads clearly at small icon sizes.",
  },
  "room-08": {
    prompt:
      "A high-definition soft candy avatar of a fairy-tale shoe house, perfectly centered front-facing view, centered square composition for a profile picture. " +
      "A cozy cottage built into a giant soft caramel-brown fondant boot, a rounded toe with a tiny warmly glowing window, laces of sugar twine, a little marshmallow roof garden with fondant flowers on top. " +
      "Background: a dreamy cloud of cotton candy in pastel peach and rose, floating sugar floss wisps, tiny sprinkles and soft glowing bokeh, airy bright pastel palette. " +
      "Smooth polished 3D render, soft studio lighting, warm candy colors, crisp details, cute cozy mood, full-bleed edge-to-edge composition with no rounded corners and no border, reads clearly at small icon sizes.",
  },
  "room-09": {
    prompt:
      "A high-definition soft candy avatar of a pumpkin-shaped cottage, perfectly centered front-facing view, centered square composition for a profile picture. " +
      "A big glossy orange fondant pumpkin with gentle ridges as the house, a tiny rounded wooden door and warmly glowing windows, a candy-stem chimney puffing soft sugar smoke, small fondant autumn leaves scattered around. " +
      "Background: a dreamy cloud of cotton candy in warm pastel peach, honey and cream, floating sugar floss wisps, tiny sprinkles and soft glowing bokeh, airy bright pastel palette. " +
      "Smooth polished 3D render, soft studio lighting, warm candy colors, crisp details, cute cozy mood, full-bleed edge-to-edge composition with no rounded corners and no border, reads clearly at small icon sizes.",
  },
  "room-10": {
    repaired: true,
    prompt:
      "A dreamy soft candy scene of a watermill cottage perched on a tiny stream, close-up view. " +
      "A cream marshmallow cottage with a mossy mint fondant roof and warmly glowing windows, a candy-paddle waterwheel resting half in glossy turquoise sugar water that flows out past the bottom corner of the image, pastel rounded stones along the bank, cotton-candy clouds in pastel aqua and peach drifting in front of the lower edge and stretching beyond all four edges, with floating sugar floss wisps, tiny sprinkles and soft glowing bokeh. " +
      "Smooth polished 3D render, soft studio lighting, warm candy colors, crisp details, cute cozy mood, reads clearly at small sizes.",
  },
  "room-11": {
    repaired: true,
    prompt:
      "A dreamy soft candy scene of an alpine A-frame cabin resting on a snowy ridge, close-up view. " +
      "A triangular fondant chalet with a steep sugar-dusted roof, warm honey-brown marshmallow log walls, one big glowing amber window, snow-capped fondant peaks and mint pines rising behind on one side, dusk clouds in pastel lilac and peach drifting in front of the lower edge and stretching beyond all four edges of the image, with floating sugar floss wisps, tiny sprinkles and soft glowing bokeh. " +
      "Smooth polished 3D render, soft studio lighting, warm candy colors, crisp details, cute cozy mood, reads clearly at small sizes.",
  },
  "room-12": {
    prompt:
      "A high-definition soft candy avatar of a fairy-tale clock tower cottage, perfectly centered front-facing view, centered square composition for a profile picture. " +
      "A tall rounded cream tower with a small glossy red candy spire and a cute fondant clock face with sugar hands, tiny warmly glowing windows down the side. " +
      "Background: a dreamy cloud of cotton candy in pastel peach, pink and cream, floating sugar floss wisps, tiny sprinkles and soft glowing bokeh, airy bright pastel palette. " +
      "Smooth polished 3D render, soft studio lighting, warm candy colors, crisp details, cute cozy mood, full-bleed edge-to-edge composition with no rounded corners and no border, reads clearly at small icon sizes.",
  },
  "room-management": {
    prompt:
      "A high-definition soft candy avatar of a tiny fairy-tale castle with a golden roof, perfectly centered front-facing view, centered square composition for a profile picture. " +
      "A soft cream marshmallow keep with small rounded towers, glossy golden candy roofs with tiny sugar-gem flags, a warmly glowing gate and windows, a little candy drawbridge over a round sugar moat, majestic but cute. " +
      "Background: a dreamy cloud of cotton candy in pastel gold, peach and lilac, floating sugar floss wisps, tiny sprinkles and soft glowing bokeh, airy bright pastel palette. " +
      "Smooth polished 3D render, soft studio lighting, warm candy colors, crisp details, cute cozy mood, full-bleed edge-to-edge composition with no rounded corners and no border, reads clearly at small icon sizes.",
  },
};

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
    // 高清平滑缩放用 lanczos
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
const names = only ?? Object.keys(PROMPTS);
const targets = names.filter((n) => PROMPTS[n]);
if (targets.length !== names.length) {
  console.error(`未知头像名: ${names.filter((n) => !PROMPTS[n]).join(",")}`);
  process.exit(1);
}

if (argv.includes("--ship")) {
  shipDrafts(targets);
  console.log(`\n出货完成 ${targets.length} 张 → ${SHIP_DIR}`);
  process.exit(0);
}

const key = apiKey();
mkdirSync(DRAFT_DIR, { recursive: true });

let ok = 0;
for (const name of targets) {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const bytes = await generateImage(key, PROMPTS[name].prompt);
      const outPath = join(DRAFT_DIR, `${name}.png`);
      writeFileSync(outPath, bytes);
      console.log(`✔ ${name}(${(bytes.length / 1024).toFixed(0)} KB)→ ${outPath}`);
      ok++;
      break;
    } catch (err) {
      console.warn(`✗ ${name} 第 ${attempt}/${attempts} 次失败: ${err.message ?? err}`);
      if (attempt === attempts) console.error(`✗✗ ${name} 放弃,可 --only=${name} 重试`);
      else await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
console.log(`\n完成 ${ok}/${targets.length} → ${DRAFT_DIR}`);
if (ok < targets.length) process.exit(1);
