/**
 * Regenerates the icon family in `public/` from the rendered mark
 * (`public/logo-icon-1024.png`), using the same Chromium the browser tests
 * use. Run after replacing that file:
 *
 *   pnpm logo
 *
 * Every size is a downscale of the one render, so the browser tab, the home
 * screen, the PWA entry and the lockups all show the same artwork. The
 * lockups set the wordmark in the app's own Nebula Sans, bundled here as a
 * data URL so the committed PNGs do not depend on whichever fonts the
 * machine doing the rendering happens to have installed.
 */
import { readFile, writeFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";

const MARK = "public/logo-icon-1024.png";
const WORDMARK_FONT = "public/fonts/nebula-sans/NebulaSans-Bold.woff2";
/** The render's own background, sampled from the master. */
const INK = "#15203c";
/** The lockup's proportions, as fractions of its 480x110 canvas. */
const LOCKUP = {
  width: 480,
  height: 110,
  mark: 64,
  inset: 14,
  gap: 16,
  text: 64,
};

/** Every size the app ships, and the files each one lands in. */
const OUTPUTS: Array<{ size: number; files: string[]; lockup?: boolean }> = [
  { size: 32, files: ["public/logo-icon-32.png"] },
  {
    size: 180,
    files: [
      "public/logo-icon-180.png",
      "public/apple-touch-icon.png",
      "public/apple-touch-icon-precomposed.png",
    ],
  },
  { size: 192, files: ["public/logo-icon-192.png"] },
  { size: 512, files: ["public/logo-icon-512.png"] },
  { size: 400, files: ["public/logo-400.png"], lockup: true },
  { size: 800, files: ["public/logo-800.png"], lockup: true },
];

/** The sizes packed into favicon.ico, smallest first. */
const ICO_SIZES = [16, 32, 48];

function dataUri(data: Buffer, type: string): string {
  return `data:${type};base64,${data.toString("base64")}`;
}

/** The mark alone, at an exact pixel size. */
async function shootMark(
  page: Page,
  source: Buffer,
  size: number,
): Promise<Buffer> {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0}
     img{display:block;width:${size}px;height:${size}px}</style>
     <img src="${dataUri(source, "image/png")}">`,
    { waitUntil: "load" },
  );
  return page.screenshot();
}

/** The mark beside the wordmark, scaled from the same 480x110 canvas. */
async function shootLockup(
  page: Page,
  source: Buffer,
  font: Buffer,
  width: number,
): Promise<Buffer> {
  const scale = width / LOCKUP.width;
  const height = Math.round(LOCKUP.height * scale);
  const px = (value: number) => (value * scale).toFixed(2);
  await page.setViewportSize({ width, height });
  await page.setContent(
    `<style>
       @font-face{font-family:"Nebula";font-weight:700;
         src:url(${dataUri(font, "font/woff2")}) format("woff2")}
       html,body{margin:0;background:transparent}
       .lockup{display:flex;align-items:center;height:${height}px;
         padding-left:${px(LOCKUP.inset)}px;gap:${px(LOCKUP.gap)}px}
       img{display:block;width:${px(LOCKUP.mark)}px;height:${px(LOCKUP.mark)}px}
       span{font-family:"Nebula",system-ui,sans-serif;font-weight:700;
         color:${INK};font-size:${px(LOCKUP.text)}px;letter-spacing:-0.01em}
     </style>
     <div class="lockup"><img src="${dataUri(source, "image/png")}"><span>Expense</span></div>`,
    { waitUntil: "load" },
  );
  return page.screenshot({ omitBackground: true });
}

/** An ICO container holding PNG payloads (Vista and later read these). */
function ico(images: Array<{ size: number; data: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const mark = await readFile(MARK);
const font = await readFile(WORDMARK_FONT);
const browser = await chromium.launch();
const page = await browser.newPage();

for (const { size, files, lockup } of OUTPUTS) {
  const data = lockup
    ? await shootLockup(page, mark, font, size)
    : await shootMark(page, mark, size);
  for (const file of files) await writeFile(file, data);
  console.info(
    `${size}px ${lockup ? "lockup" : "mark"} -> ${files.join(", ")}`,
  );
}

const icons = [];
for (const size of ICO_SIZES) {
  icons.push({ size, data: await shootMark(page, mark, size) });
}
await writeFile("public/favicon.ico", ico(icons));
console.info(`favicon.ico -> ${ICO_SIZES.join(", ")}`);

await browser.close();
