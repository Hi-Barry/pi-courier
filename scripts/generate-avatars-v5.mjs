#!/usr/bin/env node
/**
 * generate-avatars-v5.mjs — the v5 avatar art restyle (spec #84 v5).
 *
 * What changed vs v4 (scripts/generate-avatars-v4.mjs):
 *   - Generator model: qwen-image-3.0-pro via the DashScope native endpoint
 *     (v4 used seedream-4.5 via OpenRouter). Prompts are re-tuned for it.
 *   - Pool size: 24 images per set (v4: 12) — space-01..24 / room-01..24 /
 *     agent-01..24, shipped at 256×256 (v4: 512×512) so the bigger pools
 *     still shrink the package (73 files ≈ 9MB vs ≈ 17MB).
 *   - Two-axis differentiation: every image pairs a DISTINCT subject with a
 *     DISTINCT dominant hue spread across the color wheel, so coexisting
 *     deployments (spaces) and sibling rooms stay visually apart — the v4
 *     per-set single-palette direction (all-cool landscapes etc.) is retired.
 *     Set subjects: space = landscapes from aurora mountains to ringed
 *     planets and galaxies; room = architecture from cottages and chinese
 *     pavilions to castles, shrines and space pods; agent = 24 animal faces.
 *     The management room keeps its dedicated room-management.png (untouched).
 *   - Negative words: same lesson as v4 — never name a shape/composition you
 *     want excluded (mentioning it pollutes the render); only style garnish
 *     is excluded. v5 additionally excludes felt/wool/knitted to keep the
 *     smooth candy render.
 *
 * Usage (same shape as v4):
 *   DASHSCOPE_API_KEY=sk-xxx node scripts/generate-avatars-v5.mjs            # 1024 草稿 → drafts/
 *   DASHSCOPE_API_KEY=sk-xxx node scripts/generate-avatars-v5.mjs --only=space-01,room-07
 *   node scripts/generate-avatars-v5.mjs --ship                              # 草稿 → 256×256 真 PNG 入 assets/avatars/
 *
 * Drafts land in scripts/.avatar-drafts-v5/ (gitignored). Billing is per
 * successfully generated image; failed calls cost nothing. The endpoint rate
 * limits free tiers to ~1 QPS — the script sleeps between calls and retries
 * 429s with backoff, and skips drafts that already exist (resume-safe).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DRAFT_DIR = "scripts/.avatar-drafts-v5";
const SHIP_DIR = "assets/avatars";
const SHIP_SIZE = 256;
const MODEL = process.env.OPENROUTER_IMAGE_MODEL || "qwen-image-3.0-pro";
const ENDPOINT =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

// 负面词教训(沿 v4):绝不写想要排除的形状/构图(提及即污染);只封风格性装饰。
const NEGATIVE =
  "text, watermark, logo, signature, pixel art, felt, wool, knitted fabric, blocky, low resolution, blurry, frame, border, vignette, dark mood, scary";

// 统一收尾:调色板三色逐张指定(主色即该张的色环身份)。
const tail = (pal) =>
  `Smooth polished 3D render, soft studio lighting, dreamy pastel palette of ${pal}, crisp details, cute airy mood, full-bleed edge-to-edge composition with no rounded corners and no border, reads clearly at small icon sizes.`;
const OPEN_SPACE =
  "A high-definition soft candy landscape avatar, centered square composition for a profile picture.";
const OPEN_ROOM =
  "A high-definition soft candy architecture avatar, centered square composition for a profile picture.";
const OPEN_AGENT =
  "A high-definition soft candy animal avatar portrait, centered square composition for a profile picture.";

/** 72 张定稿提示词(出货原句):每张 = 独立主体 × 独立主色。 */
const SETS = [
  {
    open: OPEN_SPACE,
    items: [
      { name: "space-01", pal: "ice blue, lilac and mint", body: "A miniature snowy mountain scene under an aurora: a cluster of small rounded snow-capped mountains made of fluffy marshmallow and sugar-dusted fondant, pillowy rounded peaks. Above them a glowing green and lilac aurora ribbon curls across a soft deep-blue night sky like glowing sugar floss, with tiny sparkling sugar stars and soft bokeh, and a few tiny pastel pine trees at the foot." },
      { name: "space-02", pal: "turquoise, aqua and cream", body: "A tiny tropical island in a clear bay: a small rounded islet of sugar-dusted pale sand with two fluffy fondant palm trees, surrounded by candy-glass water in gradients of turquoise, soft sugar-foam waves lapping gently, a few rounded sugar pebbles in the shallows." },
      { name: "space-03", pal: "mint, jade and cream", body: "A misty pine forest valley: rows of small rounded fondant pine trees in graded greens drifting into soft marshmallow fog, the sky between treetops completely filled with soft glowing clouds, tiny sugar stars and bokeh, a faint sugar-dust path winding between the trees." },
      { name: "space-04", pal: "coral, apricot and peach", body: "Rounded desert dunes at dusk: smooth pillowy dunes of coral and apricot sugar sand with a fine powdered-sugar shimmer, a couple of skinny rounded fondant cacti, a low glossy candy sun melting into a soft coral-peach gradient sky with tiny bokeh stars." },
      { name: "space-05", pal: "aqua, sky blue and cream", body: "A small waterfall cascading from rounded marshmallow cliffs: glossy candy-glass water falling in soft ribbons into a round pale pool, sugar mist and glowing bokeh rising, pillowy cliffs dotted with mint fondant moss and tiny fondant ferns." },
      { name: "space-06", pal: "fresh green, lime and pink", body: "Rolling meadow hills with one giant tree: layers of pillowy green fondant hills, one huge round marshmallow tree with a puffy pastel-pink crown standing alone in the middle, tiny sugar flowers dotting the grass, soft blue sky with small cotton clouds and bokeh." },
      { name: "space-07", pal: "pale ice blue, silver and lavender", body: "A frozen sugar-glass lake with small rounded icebergs: a pale glossy candy surface like hard candy, chunky marshmallow icebergs dusted with powdered sugar, gentle snowfall and bokeh, a soft lavender horizon glow." },
      { name: "space-08", pal: "periwinkle, lilac and silver", body: "A calm night lake reflecting a big full moon: a huge soft marshmallow moon with a gentle glow above a deep sky of tiny sugar stars, mirror-still candy-glass water doubling the moon, low rounded fondant hills on the horizon." },
      { name: "space-09", pal: "rose, peach and cream", body: "A small striped candy canyon: layered fondant cliffs in soft bands of rose, peach and cream like stacked taffy, one rounded arch opening glowing warmly, a sandy sugar floor with rounded pebbles and tiny bokeh." },
      { name: "space-10", pal: "lavender, coral and charcoal", body: "A small glowing volcano rising from a pastel island shore: a rounded charcoal-sugar volcano with its rim glowing bright coral-and-gold candy lava, glossy caramel ribbons trickling down one slope, a cotton-candy smoke plume drifting up, tiny glowing ember bokeh around the peak, a lavender sugar-sand beach stretching to the edges." },
      { name: "space-11", pal: "pink, lilac and mint", body: "Endless pastel flower fields in soft bloom: neat rounded rows of tiny fondant tulips in pink, lilac and cream on pillowy green hills, one small winding sugar path, the sky above completely filled with soft morning clouds, cotton puffs and floating bokeh sparkles." },
      { name: "space-12", pal: "violet, magenta and deep indigo", body: "An outer-space scene of a ringed candy planet: a big glossy marshmallow planet with a glowing violet surface, encircled by a luminous sugar-dust ring, two small candy moons floating nearby, deep space filled with tiny sugar stars and soft magenta nebula clouds." },
      { name: "space-13", pal: "sky blue, white and gold", body: "A sea of clouds high in the sky with floating islands: fluffy white marshmallow cloud banks stretching to every edge, two or three small rounded floating islands with fondant grass and tiny trees drifting above them, warm golden sunlight and soft bokeh." },
      { name: "space-14", pal: "indigo, deep blue and silver", body: "A starry night with the Milky Way arching over rolling hills: a luminous silver sugar-dust galaxy ribbon curving across a deep indigo sky dense with tiny sugar stars, pillowy dark-blue fondant hills below, faint glowing bokeh like fireflies." },
      { name: "space-15", pal: "jade green, celadon and cream", body: "A peaceful bamboo grove with a small stream: tall rounded segments of jade-green sugar bamboo with tiny fondant leaves, a clear candy-glass creek winding between smooth celadon sugar stones, soft light beams and floating bokeh through the grove." },
      { name: "space-16", pal: "teal, aqua and moss green", body: "A winding creek over smooth candy pebbles: clear aqua candy-glass water curving through rounded moss-green fondant boulders, tiny sugar splashes and foam dots, small fondant ferns on the banks, soft glowing light and bokeh." },
      { name: "space-17", pal: "aqua, pink coral and cream", body: "A shallow underwater reef scene: rounded pink and aqua fondant corals rising from pale sugar sand, glossy candy-glass water above with soft light rays, tiny round bubbles and bokeh, small rounded fondant seashells scattered between the corals." },
      { name: "space-18", pal: "golden wheat, honey and cream", body: "A vast grassland with a single grand tree: pillowy waves of golden sugar wheat stretching to every edge, one enormous round marshmallow tree with a wide honey-green crown standing in the middle, soft cream sky with cotton clouds and floating sugar seeds." },
      { name: "space-19", pal: "peach, cream and coral", body: "Hot air balloons drifting over pastel hills: two plump rounded candy balloons with soft vertical stripes floating above pillowy fondant hills, tiny sugar baskets hanging below, a warm peach sky filled with soft cotton clouds and bokeh." },
      { name: "space-20", pal: "sakura pink, white and soft green", body: "A cherry blossom valley in full bloom: rounded sakura trees made of clustered pink sugar puff blossoms on dark fondant trunks, soft pink petals drifting through the air, a pale grass floor dotted with tiny petals, glowing morning light and bokeh." },
      { name: "space-21", pal: "maple orange, amber and cream", body: "An autumn maple forest: rounded fondant maple trees with layered orange and amber sugar leaves, a soft carpet of fallen candy leaves on the ground, warm glowing light between the trunks, tiny floating leaf bokeh." },
      { name: "space-22", pal: "purple, lilac and cream", body: "Endless lavender fields in soft bloom: neat rounded rows of purple fondant lavender stretching to every edge, one small winding sugar path leading to a tiny lone tree, the sky above completely filled with soft evening clouds, gentle bokeh sparkles." },
      { name: "space-23", pal: "chartreuse, lime and sky blue", body: "Terraced sugar fields stacked on rounded hills: curved layers of pillowy rice-terrace paddies in graded fresh greens like stacked fondant ribbons, glossy candy-glass water reflecting light on each terrace, a soft sky with cotton clouds and bokeh." },
      { name: "space-24", pal: "magenta, violet and deep blue", body: "A spiral galaxy seen from a candy mountain top: a luminous swirling galaxy of magenta and violet sugar floss spiraling in a deep-blue starry sky, the rounded silhouette of a marshmallow mountain in the lower corner, dense tiny sugar stars and glowing dust bokeh everywhere." },
    ],
  },
  {
    open: OPEN_ROOM,
    items: [
      { name: "room-01", pal: "honey gold, butterscotch and cream", body: "A plump little gingerbread cottage: pillowy marshmallow walls glazed in warm honey, a rounded fondant thatched roof dusted with golden sugar, round glossy sugar windows glowing warm amber, a tiny candy chimney with a soft cotton smoke puff, a sugar path and tiny fondant bushes at the door." },
      { name: "room-02", pal: "lilac, violet and cream", body: "A tiny lavender cottage: pillowy marshmallow walls glazed in soft lilac, a rounded fondant roof in deep violet with a fine sugar shimmer, round glossy sugar windows glowing warm gold, a tiny candy chimney with a cotton smoke puff, tiny violet fondant flowers along the sugar path." },
      { name: "room-03", pal: "jade green, celadon and cream", body: "A tiny chinese lakeside pavilion: a rounded six-sided pavilion with upturned jade-green glazed fondant roof tiers, slender cream sugar pillars, a small glowing lantern under the eaves, standing on a little fondant rock platform beside a calm candy-glass pond with a lily pad." },
      { name: "room-04", pal: "vermilion red, gold and cream", body: "A tiny multi-tiered pagoda: five stacked rounded tiers with upturned vermilion fondant roofs edged in gold sugar, a small golden finial on top, tiny glowing windows on each tier, standing on a soft fondant hill with two mini fondant pine trees." },
      { name: "room-05", pal: "periwinkle, silver and cream", body: "A tiny fairytale princess castle: three rounded marshmallow towers with cone-shaped periwinkle fondant roofs, tiny triangular sugar flags on top, a plump gatehouse with a candy drawbridge, glossy sugar windows glowing warm, a soft cloud ring around the base." },
      { name: "room-06", pal: "cyan, aqua and white", body: "A tiny futuristic dome house: a smooth glossy candy-glass dome with a circular aqua glow ring around its base, a small rounded airlock pod attached to one side, soft holographic sugar panels glowing cyan, tiny floating light drones like sugar pearls above the dome." },
      { name: "room-07", pal: "emerald, moss green and cream", body: "A tiny treehouse in a giant tree: a plump wooden fondant cabin with warm glowing round windows nestled in the crown of a huge round marshmallow tree, a tiny rope ladder and a little balcony rail made of sugar twigs, soft bokeh leaves floating around." },
      { name: "room-08", pal: "sky blue, white and cream", body: "A tiny striped lighthouse by the sea: a plump rounded tower with wide sky-blue and white candy stripes, a glowing lantern room at the top emitting a soft light beam, a small keeper's cottage at its foot, rounded sugar waves gently splashing the rocky fondant base." },
      { name: "room-09", pal: "cream, amber and soft brown", body: "A tiny dutch windmill: a plump rounded cream fondant mill body with a warm amber sugar door, four big paddle-shaped fondant sails with lace sugar edges, a rounded thatched cap, tiny tulip-like fondant flowers dotting the grass around." },
      { name: "room-10", pal: "sakura pink, white and moss green", body: "A tiny japanese shrine with a torii gate: a small rounded shrine house with a curved sakura-pink fondant roof and white sugar walls, a rose vermillion-tinted rounded torii gate standing before it, tiny glowing paper lanterns, soft pink sugar petals drifting in the air." },
      { name: "room-11", pal: "ice blue, white and silver", body: "A tiny igloo: a plump half-dome built of glossy ice-blue sugar blocks like hard candy, a small rounded entrance tunnel, warm golden light glowing from a tiny round window, soft powdery snow drifts and tiny bokeh sparkles around the base." },
      { name: "room-12", pal: "strawberry red, white and green", body: "A tiny mushroom house: a plump cream marshmallow stem-house under a giant glossy strawberry-red fondant cap dotted with round white sugar spots, a rounded wooden candy door with a tiny round window glowing warm, a little grassy fondant mound with tiny flowers." },
      { name: "room-13", pal: "peach, sandy cream and coral", body: "A tiny sand castle on a beach: plump rounded towers with cone tops sculpted from peach sugar sand, tiny shell-shaped fondant decorations on the walls, a small glossy candy-glass moat with sugar-foam waves, a tiny pail and rounded pebbles beside it." },
      { name: "room-14", pal: "fuchsia, magenta and silver", body: "A tiny crystal palace: a rounded central dome with two symmetrical crystal wings made of glossy fuchsia candy-glass facets, silver sugar trim along every edge, soft inner glow shining through the facets, tiny sparkling bokeh floating around the spires." },
      { name: "room-15", pal: "slate blue, stone gray and cream", body: "A tiny stone watchtower: a plump cylindrical tower of rounded slate-blue sugar stones with a wider crowned top, tiny arched glowing windows, a small fondant flag fluttering from the roof, soft mist and a grassy fondant mound at the base." },
      { name: "room-16", pal: "caramel, warm brown and cream", body: "A tiny winter log cabin: plump rounded logs of glossy caramel fondant stacked into a cozy cabin, a deep snow-covered marshmallow roof, warm amber light glowing from the windows, a tiny candy chimney with a soft smoke puff, powdery sugar snow and two mini fondant pines." },
      { name: "room-17", pal: "azure, white and cream", body: "A tiny mediterranean dome villa: a plump white marshmallow villa with a big glossy azure-blue fondant dome, rounded arched windows glowing warm, a tiny balcony rail of white sugar, two mini fondant cypress trees and a sunlit sugar-stone terrace." },
      { name: "room-18", pal: "coral, peach and sky blue", body: "A tiny floating balloon house: a plump little cottage lifted by one huge glossy coral candy balloon with a soft shine, thin sugar-string rigging down to the marshmallow roof, tiny cloud puffs drifting past, the ground far below as pillowy fondant hills." },
      { name: "room-19", pal: "chartreuse, lime and white", body: "A tiny glass greenhouse: a plump rounded greenhouse of glossy chartreuse candy-glass panels with white sugar frames, warm glowing light inside revealing tiny fondant plants and flowers on shelves, a little arched door, tiny potted fondant plants lined up outside." },
      { name: "room-20", pal: "lemon yellow, mint and cream", body: "A tiny candy shop storefront: a plump two-story front with lemon-yellow fondant walls and mint sugar trim, a big rounded lollipop sign above the awning, striped candy columns, a display window full of tiny glossy sugar sweets glowing warm." },
      { name: "room-21", pal: "antique gold, warm red and cream", body: "A tiny chinese temple: a plump hall with a grand double-eaved curved roof of antique-gold glazed fondant, warm red sugar walls and pillars, tiny round windows glowing warm, a small incense burner with a soft smoke curl, rounded fondant stone steps and two mini sugar lanterns." },
      { name: "room-22", pal: "silver, lavender and deep blue", body: "A tiny space station pod house: a plump rounded silver candy capsule with a big glossy observation dome glowing lavender, tiny landing legs of sugar steel, small blinking fondant lights along the hull, a tiny antenna, floating sugar-star bokeh and a soft planet horizon below." },
      { name: "room-23", pal: "teal, warm wood and cream", body: "A tiny water mill by a stream: a plump wooden fondant mill house with a big rounded paddle wheel turning in clear teal candy-glass water, glossy water ribbons spilling from the wheel, warm glowing windows, a tiny stone sugar bridge and mossy fondant banks." },
      { name: "room-24", pal: "rose gold, blush pink and cream", body: "A tiny fairytale tower: a tall plump cylindrical tower of rose-gold sugar bricks with a cone-shaped blush-pink fondant roof, a tiny round window glowing warm near the top, glossy braided sugar hair hanging from the window, soft clouds drifting around the base." },
    ],
  },
  {
    open: OPEN_AGENT,
    items: [
      { name: "agent-01", pal: "mint green, cream and a touch of coral", body: "A cute mint-green fox face: a round fluffy head of soft mint marshmallow fur, big glossy dark-sugar eyes, tiny rounded fondant ears with pale cream inner fur, a small sugar nose and a gentle smile, head and fluffy cheeks filling the frame." },
      { name: "agent-02", pal: "rose pink, cream and a touch of lilac", body: "A cute rose-pink bunny face: a round fluffy head of soft rose marshmallow fur, tall pillowy fondant ears with pale cream inner fur, big glossy dark-sugar eyes, a tiny sugar nose and a gentle smile, head and cheeks filling the frame." },
      { name: "agent-03", pal: "lavender, lilac and cream", body: "A cute lavender cat face: a round head of soft lavender marshmallow fur, big glossy dark-sugar eyes, tiny pointed fondant ears with pale pink inner fur, little sugar whiskers, a tiny pink nose and a gentle smile, head and cheeks filling the frame." },
      { name: "agent-04", pal: "honey gold, cream and warm caramel", body: "A cute golden puppy face: a round fluffy head of soft honey-gold marshmallow fur, floppy rounded fondant ears, big glossy dark-sugar eyes, a small dark sugar nose and a happy open smile with a hint of tongue, head and cheeks filling the frame." },
      { name: "agent-05", pal: "caramel brown, cream and honey", body: "A cute bear cub face: a round head of soft caramel marshmallow fur, small round fondant ears on top, big glossy dark-sugar eyes, a cream sugar muzzle with a tiny dark nose and a gentle smile, head and chubby cheeks filling the frame." },
      { name: "agent-06", pal: "slate blue, silver gray and cream", body: "A cute raccoon face: a round head of soft slate-blue marshmallow fur, a cream sugar face mask patch around big glossy dark eyes, tiny rounded fondant ears with dark tips, a small dark sugar nose, faint striped sugar cheeks, head filling the frame." },
      { name: "agent-07", pal: "sage green, white and charcoal", body: "A cute panda face: a round head of soft sage-tinted white marshmallow fur, two rounded charcoal-sugar ear patches, big glossy dark-sugar eye patches like shiny candy drops, a tiny dark nose and a gentle smile, head and cheeks filling the frame." },
      { name: "agent-08", pal: "silver blue, soft gray and cream", body: "A cute koala face: a round head of soft silver-blue marshmallow fur, big fluffy rounded fondant ears, a large oval cream sugar nose, small glossy dark-sugar eyes with sleepy content lids, head and cheeks filling the frame." },
      { name: "agent-09", pal: "peach, apricot and cream", body: "A cute sloth face: a round head of soft peach marshmallow fur, a wide cream sugar face patch around big glossy dark-sugar eyes with sleepy content lids, small smudgy fondant eye stripes, a tiny smile, wispy fur tufts, head filling the frame." },
      { name: "agent-10", pal: "cinnamon, warm brown and cream", body: "A cute hedgehog face: a round cream sugar face framed by soft cinnamon-brown marshmallow spines like rounded candy quills, tiny dark-sugar eyes, a small glossy brown nose at the tip, little rounded fondant ears and rosy sugar cheeks, head filling the frame." },
      { name: "agent-11", pal: "ice blue, white and soft gray", body: "A cute penguin face: a round plump head of glossy ice-blue and white marshmallow, two big glossy dark-sugar eyes, a tiny triangular fondant beak in warm orange sugar, rosy cheek dots, a few soft head feathers as sugar tufts, head filling the frame." },
      { name: "agent-12", pal: "periwinkle, cream and gold", body: "A cute owl face: a round head of soft periwinkle marshmallow feathers, two huge round glossy sugar eyes with dark pupils and tiny light sparks, a small cream heart-shaped sugar face disk, a tiny triangle beak, little tufted ear feathers, head filling the frame." },
      { name: "agent-13", pal: "cream, apricot and soft brown", body: "A cute fawn face: a round head of soft cream marshmallow fur, big glossy dark-sugar eyes with long lashes, tiny rounded fondant ears sticking out, a small cluster of glossy apricot sugar spots on the forehead, a tiny dark nose and gentle smile, head filling the frame." },
      { name: "agent-14", pal: "sky blue, powder blue and cream", body: "A cute elephant face: a round head of soft sky-blue marshmallow skin, big floppy rounded fondant ears with powder-blue inner, small glossy dark-sugar eyes, a plump little trunk curling gently with a happy smile below, head and cheeks filling the frame." },
      { name: "agent-15", pal: "blush pink, rose and cream", body: "A cute piglet face: a round chubby head of glossy blush-pink marshmallow skin, two triangular folded fondant ears, big glossy dark-sugar eyes, a round snout with two tiny nostril dots, rosy sugar cheeks and a happy smile, head filling the frame." },
      { name: "agent-16", pal: "tangerine orange, cream and charcoal", body: "A cute tiger cub face: a round head of soft tangerine marshmallow fur with a cream sugar muzzle, a few rounded charcoal fondant stripes on the forehead and cheeks, big glossy dark-sugar eyes, tiny rounded ears, a small pink nose and a playful smile, head filling the frame." },
      { name: "agent-17", pal: "golden yellow, honey and cream", body: "A cute lion cub face: a round head surrounded by a big puffy mane of soft golden sugar floss, a honey marshmallow face with big glossy dark-sugar eyes, tiny rounded ears peeking through the mane, a small dark nose and a proud little smile, head and mane filling the frame." },
      { name: "agent-18", pal: "cocoa, mocha brown and cream", body: "A cute monkey face: a round head of soft cocoa marshmallow fur framing a heart-shaped cream sugar face, big glossy dark-sugar eyes, two small rounded fondant ears on the sides, a tiny smile and a little tuft of fur on top, head filling the frame." },
      { name: "agent-19", pal: "cream, lilac and soft white", body: "A cute lamb face: a round fluffy head made of puffy cream marshmallow wool curls, a lilac-tinted fondant face with big glossy dark-sugar eyes, small folded sugar ears, a tiny dark nose and a gentle smile, woolly head and cheeks filling the frame." },
      { name: "agent-20", pal: "lemon yellow, cream and soft orange", body: "A cute duckling face: a round plump head of soft lemon-yellow marshmallow fluff, big glossy dark-sugar eyes, a wide glossy soft-orange fondant bill with tiny nostril dots, rosy sugar cheeks and one tiny feather tuft on top, head filling the frame." },
      { name: "agent-21", pal: "lime green, fresh green and cream", body: "A cute frog face: a round plump head of glossy lime marshmallow skin, two big bulgy glossy sugar eyes sitting on top like round candy domes, rosy sugar cheeks, a wide happy smile, tiny nostril dots, a soft sheen like polished candy glass, head filling the frame." },
      { name: "agent-22", pal: "white, magenta and soft gold", body: "A cute unicorn face: a round head of soft white marshmallow fur with a spiral glossy gold fondant horn, a flowing mane of magenta and lilac sugar floss, big glossy dark-sugar eyes with long lashes, tiny rounded ears and a gentle smile, head and mane filling the frame." },
      { name: "agent-23", pal: "jade green, emerald and gold", body: "A cute baby dragon face: a round chubby head of glossy jade marshmallow scales like polished candy, two small rounded fondant horns, big glossy dark-sugar eyes, tiny folded sugar wings behind the cheeks, a sprinkle of gold sugar freckles and a happy smile, head filling the frame." },
      { name: "agent-24", pal: "salmon pink, coral and cream", body: "A cute axolotl face: a round plump head of glossy salmon-pink marshmallow skin, three pairs of feathery coral sugar gills fanning out like soft candy fronds, big glossy dark-sugar eyes with a sleepy happy look, a tiny wide smile, head and gills filling the frame." },
    ],
  },
];

const PROMPTS = Object.fromEntries(
  SETS.flatMap((set) => set.items.map((it) => [it.name, { prompt: `${set.open} ${it.body} ${tail(it.pal)}` }])),
);

// ---- key --------------------------------------------------------------------

function apiKey() {
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY;
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".zcode", "v2", "config.json"), "utf8"));
    for (const p of Object.values(cfg.provider ?? {})) {
      const opts = p.options ?? {};
      if (String(opts.baseURL ?? "").includes("dashscope") || String(opts.baseURL ?? "").includes("maas.aliyuncs.com")) {
        if (opts.apiKey) return opts.apiKey;
      }
    }
  } catch {
    // fall through
  }
  console.error("缺少 DASHSCOPE_API_KEY");
  process.exit(1);
}

// ---- API --------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generateImage(key, prompt) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      input: { messages: [{ role: "user", content: [{ text: prompt }] }] },
      parameters: { negative_prompt: NEGATIVE, prompt_extend: false, watermark: false, size: "1024*1024" },
    }),
  });
  const data = await res.json().catch(() => null);
  if (res.status === 429) throw Object.assign(new Error("Throttling.RateQuota"), { retry429: true });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  const url = data?.output?.choices?.[0]?.message?.content?.[0]?.image;
  if (!url) throw new Error(`响应无图: ${JSON.stringify(data).slice(0, 300)}`);
  const img = await fetch(url);
  if (!img.ok) throw new Error(`下载失败 HTTP ${img.status}`);
  return Buffer.from(await img.arrayBuffer());
}

// ---- ship(草稿 → 正式 256×256 真 PNG) --------------------------------------

function shipDrafts(names) {
  for (const name of names) {
    const draft = join(DRAFT_DIR, `${name}.png`);
    const out = join(SHIP_DIR, `${name}.png`);
    // 高清平滑缩放用 lanczos(v4 同款)
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

let failed = [];
for (let i = 0; i < targets.length; i++) {
  const name = targets[i];
  const draft = join(DRAFT_DIR, `${name}.png`);
  if (existsSync(draft)) {
    console.log(`↷ [${i + 1}/${targets.length}] ${name} 草稿已存在,跳过`);
    continue;
  }
  const backoffs = [0, 30000, 60000, 120000];
  let ok = false;
  for (let attempt = 0; attempt < backoffs.length && !ok; attempt++) {
    if (backoffs[attempt]) {
      console.log(`  429 退避 ${backoffs[attempt] / 1000}s 后重试(第 ${attempt} 次)`);
      await sleep(backoffs[attempt]);
    }
    const t0 = Date.now();
    try {
      const bytes = await generateImage(key, PROMPTS[name].prompt);
      writeFileSync(draft, bytes);
      console.log(`✔ [${i + 1}/${targets.length}] ${name} (${(bytes.length / 1024).toFixed(0)}KB, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      ok = true;
    } catch (e) {
      if (e.retry429) continue;
      console.error(`✘ [${i + 1}/${targets.length}] ${name}: ${e.message}`);
      failed.push(name);
      break;
    }
  }
  if (!ok && failed[failed.length - 1] !== name) failed.push(name);
  await sleep(2500);
}
console.log(`\n草稿完成: 成功 ${targets.length - failed.length}/${targets.length}${failed.length ? ",失败: " + failed.join(",") : ""}`);
if (failed.length) process.exit(2);
