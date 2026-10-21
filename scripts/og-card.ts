/**
 * Regenerates the social card in `public/og-card.png`: the image every
 * marketing page advertises as its og:image, and the one a link preview
 * shows when someone shares the site.
 *
 * The card is composed here rather than rendered by a route, because the
 * repo ships its marketing images as committed artifacts (see `pnpm logo`
 * and `pnpm figures`) and a link preview wants one image, not a render per
 * crawler hit. It pairs the app's own copy (app/data/site.yaml, the same
 * headline the landing page shows) with a shot of the app
 * (public/screenshot-hero.png, which `pnpm screenshot` refreshes), drawn in
 * Chromium with the app's typeface embedded, so the committed PNG does not
 * depend on the fonts installed on the machine that made it.
 *
 * Run it with `pnpm og`, after `pnpm screenshot` has refreshed the capture.
 */
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import sharp from "sharp";
import { parse as parseYaml } from "yaml";

/** The card's size, in the pixels every platform expects. */
const WIDTH = 1200;
const HEIGHT = 630;

/** The app capture the card shows: the signed-in expense list. */
const HERO = "public/screenshot-hero.png";
/** The brand lockup (mark and wordmark), as the app ships it. */
const LOCKUP = "public/logo-800.png";
/** The site's brand copy: the card's headline is read from it. */
const SITE_COPY = "app/data/site.yaml";
/** The app's typeface, embedded so the card renders the same anywhere. */
const BOLD_FONT = "public/fonts/nebula-sans/NebulaSans-Bold.woff2";
/** Where the card lands. */
const OUTPUT = "public/og-card.png";

/** The capture is a 1440px-wide viewport, shrunk to 1600px wide. */
const HERO_CAPTURE = 1600;

/**
 * The part of the app the card shows, in the capture's own pixels: the
 * content column (300 to 1290; the app centers it) from below the app's own
 * header (98) down to the gap between two expense rows (916), so the last
 * row the card shows is a whole one. The header is left out because the
 * card carries the brand itself, and two wordmarks read as a mistake.
 */
const CROP = { left: 300, top: 98, right: 1290, bottom: 916 };

/** The frame the app capture sits in, and the width it is drawn at. */
const FRAME_WIDTH = 620;
const BAR_HEIGHT = 38;

function dataUri(data: Buffer, type: string): string {
  return `data:${type};base64,${data.toString("base64")}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * The card's headline, from the same file the landing page reads it from.
 * The app fills its placeholders at build time; the card has no such
 * values, so a headline that asks for one is a mistake worth failing on.
 */
async function headline(): Promise<string> {
  const parsed = parseYaml(await readFile(SITE_COPY, "utf8")) as Record<
    string,
    unknown
  >;
  const value = parsed.appHeadline;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${SITE_COPY} has no appHeadline for the card to show`);
  }
  if (value.includes("{{")) {
    throw new Error(
      `${SITE_COPY}'s appHeadline asks for a placeholder the card cannot fill`,
    );
  }
  return value.trim();
}

/** The app capture, cropped to the part the card shows. */
async function shot(): Promise<Buffer> {
  const image = sharp(await readFile(HERO));
  const meta = await image.metadata();
  if (meta.width !== HERO_CAPTURE) {
    throw new Error(
      `${HERO} is ${meta.width}px wide, not ${HERO_CAPTURE}: the capture moved, so the card's crop needs new numbers`,
    );
  }
  return image
    .extract({
      left: CROP.left,
      top: CROP.top,
      width: CROP.right - CROP.left,
      height: CROP.bottom - CROP.top,
    })
    .png()
    .toBuffer();
}

const title = await headline();
const [app, lockup, bold] = await Promise.all([
  shot(),
  readFile(LOCKUP),
  readFile(BOLD_FONT),
]);

// The frame is sized from the crop, so the capture is shown whole: a
// viewport that cuts a row in half reads as a mistake rather than as a
// window onto a longer list.
const shotWidth = CROP.right - CROP.left;
const innerHeight = Math.round(
  (CROP.bottom - CROP.top) * (FRAME_WIDTH / shotWidth),
);
const frameHeight = innerHeight + BAR_HEIGHT;
const frameTop = Math.round((HEIGHT - frameHeight) / 2);

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @font-face{font-family:"Nebula";font-weight:700;src:url(${dataUri(bold, "font/woff2")}) format("woff2")}
  html,body{margin:0;padding:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden}
  body{background:#f8f7f2;font-family:"Nebula",system-ui,sans-serif;color:#171717}
  .copy{position:absolute;left:64px;top:0;height:${HEIGHT}px;width:428px;
    display:flex;flex-direction:column;justify-content:center;gap:34px}
  .lockup{display:block;width:200px;height:auto}
  h1{margin:0;font-size:54px;line-height:1.06;font-weight:700;letter-spacing:-0.02em}
  .frame{position:absolute;top:${frameTop}px;right:56px;width:${FRAME_WIDTH}px;height:${frameHeight}px;
    background:#fff;border-radius:12px;overflow:hidden;
    box-shadow:0 25px 50px -12px rgba(23,23,23,.18),0 0 0 1px rgba(23,23,23,.06)}
  .bar{height:${BAR_HEIGHT}px;display:flex;align-items:center;gap:8px;padding:0 16px;
    background:#f4f2ea;border-bottom:1px solid #d7d3c8}
  .dot{width:12px;height:12px;border-radius:50%}
  .shot{display:block;width:100%;height:${innerHeight}px;object-fit:cover;object-position:top}
</style></head>
<body>
  <div class="copy">
    <img class="lockup" src="${dataUri(lockup, "image/png")}">
    <h1>${escapeHtml(title)}</h1>
  </div>
  <div class="frame">
    <div class="bar">
      <span class="dot" style="background:#c98a83"></span>
      <span class="dot" style="background:#c99e46"></span>
      <span class="dot" style="background:#5f9e7f"></span>
    </div>
    <img class="shot" src="${dataUri(app, "image/png")}">
  </div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 2,
});
await page.setContent(html, { waitUntil: "load" });
const rendered = await page.screenshot({ type: "png" });
await browser.close();

await writeFile(
  OUTPUT,
  await sharp(rendered).resize(WIDTH, HEIGHT).png().toBuffer(),
);
console.info(`${OUTPUT} -> ${WIDTH}x${HEIGHT}`);
