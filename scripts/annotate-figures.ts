/**
 * Renders the figures: the annotated receipt, in the app's own hand (the
 * vendored neat-annotations sheet and Shantell Sans) on the app's own paper
 * (the OCR fixture), wide for the README and portrait for the landing page's
 * phone width. Run after changing any of those:
 *
 *   pnpm figures
 *
 * Every figure is one entry in `FIGURES`: the PNG it is written to, the box it
 * is drawn in, and its markup with the figure's own CSS. The render embeds the
 * annotation sheet and both fonts as data URIs, so a committed PNG never
 * depends on the fonts the machine doing the rendering happens to have
 * installed.
 *
 * Each figure is rasterized at 2x and measured first: an annotation draws its
 * arrow and its label outside the element it points at, so the failure worth
 * catching is an arrow or a label that runs off the edge of the canvas.
 */
import { readFile, writeFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import sharp from "sharp";
import { parse as parseYaml } from "yaml";

const ANNOTATIONS = "app/neat-annotations.css";
const CATEGORIES = "app/data/default-categories.csv";
const LABEL_FONT = "public/fonts/shantell-sans/ShantellSans-Variable.woff2";
const RECEIPT_FONT =
  "node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2";
const RECEIPT = "test/fixtures/images/blue-bottle.yaml";

/** The app's light palette (app/global.css). */
const CANVAS = "#f8f7f2";
const INK = "#171717";
const PAPER = "#ffffff";
const HAIRLINE = "#d7d3c8";

/** Every figure is rasterized at this multiple of its CSS size. */
const SCALE = 2;
/** How close an arrow or a label may come to the edge of a figure before the
 * figure counts as clipped. */
const MIN_MARGIN = 8;

/** The receipt paper: the app renders its email receipts in the same mono at
 * 14px/22px (app/lib/receipt-render.server.ts). */
const FONT_SIZE = 17;
const LINE_HEIGHT = 1.8;
const PADDING_X = 38;
const PADDING_Y = 48;
/** JetBrains Mono advances 0.6em per character, so a receipt is as wide as its
 * longest line. */
const CHAR_WIDTH = FONT_SIZE * 0.6;

/**
 * Canvas around the paper: the margins of the crop that read best by hand, not
 * a centring. The "total" note hangs off the paper's left and the "filed as
 * ..." note sits below it, so left and bottom carry more room than the other
 * two sides. The paper is rotated, so its bounding box runs a few px wider than
 * the box these margins measure: the values place the crop, and the render's
 * own margin assertions catch a receipt whose longest line ever grows past
 * them.
 */
const MARGIN = { left: 106.4, right: 140.4, top: 56.2, bottom: 121.2 };

/**
 * The portrait figure's paper: the same receipt at the size a phone can read.
 * The landing page shows the figure 358px wide, so the mono has to survive the
 * scale down: this canvas is 384px, the phone scales it by 0.93, and the 13px
 * receipt reads at 12px.
 */
const PORTRAIT_FONT_SIZE = 13;
const PORTRAIT_LINE_HEIGHT = 1.75;
const PORTRAIT_PADDING_X = 20;
const PORTRAIT_PADDING_Y = 72;

/**
 * Canvas around the portrait's paper. The paper takes up nearly the whole
 * width, so the notes stack above and below it rather than hanging off its
 * sides: the top padding holds the merchant's note and its arrow, the bottom
 * holds the total's, and the bottom margin holds the paper's own note.
 */
const PORTRAIT_MARGIN = { left: 30.6, right: 30.6, top: 32, bottom: 100 };

interface Figure {
  out: string;
  width: number;
  height: number;
  /** The figure's markup, its own `<style>` included. */
  html: string;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A receipt fixture: the app's OCR ground truth (test/receipt-ocr.test.ts). */
interface Receipt {
  merchant: string;
  text: string;
}

/** What the browser reported about a figure after rendering it. */
interface Measured {
  annotations: Array<{
    note: string;
    tag: string;
    box: Box;
    margin: number;
    label: string;
    labelFont: string;
  }>;
  scrollWidth: number;
  scrollHeight: number;
  labelFont: boolean;
  receiptFont: boolean;
}

/** An arrow (`::before`) or a label (`::after`) box, as laid out. */
interface Pseudo {
  note: string;
  pseudo: string;
  box: Box;
  margin: number;
}

function dataUri(data: Buffer, type: string): string {
  return `data:${type};base64,${data.toString("base64")}`;
}

/** The axis-aligned box a four-point quad covers. Annotation boxes ride along
 * with the rotated paper, so this is the conservative bound on them. */
function quadBox(quad: number[]): Box {
  if (quad.length !== 8) throw new Error(`not a quad: ${quad.join(",")}`);
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  };
}

function format(box: Box): string {
  return `${box.x.toFixed(1)},${box.y.toFixed(1)} ${box.width.toFixed(1)}x${box.height.toFixed(1)}`;
}

/** Fixture text and category names go into the document as they are read, so a
 * receipt carrying an ampersand cannot break the markup. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The Meals row of the seeded categories (app/data/default-categories.csv):
 * the figure names a category the app actually hands out. */
function mealsCategory(csv: string): string {
  const name = csv
    .split("\n")
    .map((row) => row.trim().replace(/^"|"$/g, ""))
    .find((row) => row.startsWith("Meals"));
  if (name === undefined) throw new Error(`no Meals category in ${CATEGORIES}`);
  return name;
}

/** One figure's markup in the document every figure shares: the vendored
 * annotation sheet, then the two bundled fonts as data URIs. */
function render(html: string): string {
  return `<!doctype html>
<html style="color-scheme:light">
  <head>
    <meta charset="utf-8">
    <style>
${annotationsCss}
@font-face {
  font-family: "Shantell Sans";
  font-weight: 300 800;
  font-style: normal;
  font-display: block;
  src: url(${dataUri(labelFont, "font/woff2")}) format("woff2");
}
@font-face {
  font-family: "JetBrains Mono";
  font-weight: 100 800;
  font-style: normal;
  font-display: block;
  src: url(${dataUri(receiptFont, "font/woff2")}) format("woff2-variations");
}
    </style>
  </head>
  <body>${html}</body>
</html>`;
}

/** The paper's own CSS: the app's light palette, JetBrains Mono at the size
 * the email renderer uses, and the geometry that leaves the notes their room.
 * A figure that needs a different paper passes its own sizes; the README
 * figure omits them and keeps the app's. */
function receiptCss(paper: {
  columns: number;
  width: number;
  height: number;
  left: number;
  top: number;
  font?: {
    size: number;
    lineHeight: number;
    paddingX: number;
    paddingY: number;
  };
}): string {
  const font = paper.font ?? {
    size: FONT_SIZE,
    lineHeight: LINE_HEIGHT,
    paddingX: PADDING_X,
    paddingY: PADDING_Y,
  };
  const advance = font.size * 0.6;
  return `
html, body { margin: 0; }
body {
  width: ${paper.width}px;
  height: ${paper.height}px;
  background: ${CANVAS};
  color: ${INK};
  overflow: hidden;
}
.figure {
  position: relative;
  width: ${paper.width}px;
  height: ${paper.height}px;
}
.paper {
  position: absolute;
  left: ${paper.left}px;
  top: ${paper.top}px;
  width: ${paper.columns * advance}px;
  padding: ${font.paddingY}px ${font.paddingX}px;
  background: ${PAPER};
  border: 1px solid ${HAIRLINE};
  border-radius: 4px;
  font-family: "JetBrains Mono", ui-monospace, Menlo, monospace;
  font-size: ${font.size}px;
  line-height: ${font.lineHeight};
  white-space: pre;
  transform: rotate(-1.2deg);
}
/* The annotation sheet makes its elements inline-blocks with a tight line
   height; the receipt's rows are full-width blocks, so a note pointing at a
   row draws its arrow in the margin beside the paper rather than on it. */
.paper .line { display: block; line-height: ${font.lineHeight}; }
.paper .total { font-weight: 700; }
`;
}

/** The receipt figure, annotated the way a person would mark one up: the
 * merchant and the total called out from the margins, the paper itself filed
 * as the seeded Meals category. */
function receiptFigure(receipt: Receipt, category: string): Figure {
  const lines = receipt.text.replace(/\n+$/, "").split("\n");
  const merchantRow = Math.max(
    lines.findIndex((line) => line.trim() === receipt.merchant),
    0,
  );
  const totalRow = lines.findIndex((line) =>
    line.trimStart().startsWith("TOTAL"),
  );
  if (totalRow < 0) throw new Error(`no TOTAL line in ${RECEIPT}`);

  const columns = Math.max(...lines.map((line) => line.length));
  const paperWidth = columns * CHAR_WIDTH + PADDING_X * 2 + 2;
  const paperHeight =
    lines.length * FONT_SIZE * LINE_HEIGHT + PADDING_Y * 2 + 2;
  const left = MARGIN.left;
  const top = MARGIN.top;
  // Playwright wants integer viewport sizes; the paper keeps its exact
  // fractional offsets, so only the canvas trims a sub-pixel.
  const width = Math.round(left + paperWidth + MARGIN.right);
  const height = Math.round(top + paperHeight + MARGIN.bottom);

  /** The rows that carry a note. A note draws its arrow and its label ~50px to
   * the side of what it points at, so each row is annotated on the side where
   * that lands in the margin beside the paper: the merchant from the right,
   * the total from the left. */
  const notes = new Map([
    [merchantRow, { classes: "ann ann-w ann-blue", note: "merchant" }],
    [totalRow, { classes: "total ann ann-e ann-blue", note: "total" }],
  ]);
  const rows = lines.map((line, index) => {
    const annotation = notes.get(index);
    const classes = annotation ? `line ${annotation.classes}` : "line";
    const dataNote = annotation ? ` data-note="${annotation.note}"` : "";
    return `<div class="${classes}"${dataNote}>${escapeHtml(line)}</div>`;
  });

  // No whitespace between the rows: the paper renders `white-space: pre`, so a
  // newline between two blocks would draw an extra blank line.
  const paper = receiptCss({ columns, width, height, left, top });
  const note = `filed as ${escapeHtml(category)}`;
  return {
    out: "public/figure-receipt.png",
    width,
    height,
    html:
      `<style>${paper}</style><div class="figure">` +
      `<div class="paper ann ann-n ann-green ann-no-mark" data-note="${note}">` +
      `${rows.join("")}</div></div>`,
  };
}

/** The portrait figure: the same receipt, the same three notes, at a size a
 * phone can read. The paper is nearly as wide as the canvas, so there is no
 * margin left or right to hang a note in and the notes stack instead: the
 * merchant's above its row, the total's below its row (above it would land on
 * the printed lines), and the paper's own below the paper. */
function receiptPortraitFigure(receipt: Receipt, category: string): Figure {
  const lines = receipt.text.replace(/\n+$/, "").split("\n");
  const merchantRow = Math.max(
    lines.findIndex((line) => line.trim() === receipt.merchant),
    0,
  );
  const totalRow = lines.findIndex((line) =>
    line.trimStart().startsWith("TOTAL"),
  );
  if (totalRow < 0) throw new Error(`no TOTAL line in ${RECEIPT}`);

  const columns = Math.max(...lines.map((line) => line.length));
  const advance = PORTRAIT_FONT_SIZE * 0.6;
  const paperWidth = columns * advance + PORTRAIT_PADDING_X * 2 + 2;
  const paperHeight =
    lines.length * PORTRAIT_FONT_SIZE * PORTRAIT_LINE_HEIGHT +
    PORTRAIT_PADDING_Y * 2 +
    2;
  const left = PORTRAIT_MARGIN.left;
  const top = PORTRAIT_MARGIN.top;
  const width = Math.round(left + paperWidth + PORTRAIT_MARGIN.right);
  const height = Math.round(top + paperHeight + PORTRAIT_MARGIN.bottom);

  /** The rows that carry a note, each annotated on the side where its arrow and
   * label have room: the merchant's above the row, the total's below it. */
  const notes = new Map([
    [merchantRow, { classes: "ann ann-s ann-blue", note: "merchant" }],
    [totalRow, { classes: "total ann ann-n ann-blue", note: "total" }],
  ]);
  const rows = lines.map((line, index) => {
    const annotation = notes.get(index);
    const classes = annotation ? `line ${annotation.classes}` : "line";
    const dataNote = annotation ? ` data-note="${annotation.note}"` : "";
    return `<div class="${classes}"${dataNote}>${escapeHtml(line)}</div>`;
  });

  const paper = receiptCss({
    columns,
    width,
    height,
    left,
    top,
    font: {
      size: PORTRAIT_FONT_SIZE,
      lineHeight: PORTRAIT_LINE_HEIGHT,
      paddingX: PORTRAIT_PADDING_X,
      paddingY: PORTRAIT_PADDING_Y,
    },
  });
  const note = `filed as ${escapeHtml(category)}`;
  return {
    out: "public/figure-receipt-portrait.png",
    width,
    height,
    html:
      `<style>${paper}</style><div class="figure">` +
      `<div class="paper ann ann-n ann-green ann-no-mark" data-note="${note}">` +
      `${rows.join("")}</div></div>`,
  };
}

/** What the page says about the figure's annotations: the elements' own rects,
 * the notes they carry, and whether both fonts loaded (a label drawn in the
 * `cursive` fallback is not the figure anyone asked for). */
async function measure(page: Page, figure: Figure): Promise<Measured> {
  return page.evaluate(
    ({ width, height }) => {
      const annotations = [...document.querySelectorAll(".ann")].map(
        (element) => {
          const rect = element.getBoundingClientRect();
          const label = getComputedStyle(element, "::after");
          return {
            note: element.getAttribute("data-note") ?? "",
            tag: element.tagName.toLowerCase(),
            box: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
            margin: Math.min(
              rect.x,
              rect.y,
              width - rect.right,
              height - rect.bottom,
            ),
            label: label.content,
            labelFont: label.fontFamily,
          };
        },
      );
      const scroller = document.scrollingElement;
      return {
        annotations,
        scrollWidth: scroller?.scrollWidth ?? 0,
        scrollHeight: scroller?.scrollHeight ?? 0,
        labelFont: document.fonts.check('400 16px "Shantell Sans"'),
        receiptFont: document.fonts.check('400 15px "JetBrains Mono"'),
      };
    },
    { width: figure.width, height: figure.height },
  );
}

/** The arrow and label boxes, from the layout engine: `::before` and `::after`
 * are what hangs off the side of an annotation, so they are what runs off the
 * edge of a figure. */
async function pseudoBoxes(page: Page, figure: Figure): Promise<Pseudo[]> {
  const client = await page.context().newCDPSession(page);
  try {
    const { root } = await client.send("DOM.getDocument");
    if (root.nodeId === undefined) throw new Error("no document node");
    const { nodeIds } = await client.send("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector: ".ann",
    });
    const boxes: Pseudo[] = [];
    for (const nodeId of nodeIds) {
      const { node } = await client.send("DOM.describeNode", { nodeId });
      const attributes = node.attributes ?? [];
      const note = attributes[attributes.indexOf("data-note") + 1] ?? "unnamed";
      for (const pseudo of node.pseudoElements ?? []) {
        if (pseudo.nodeId === undefined) continue;
        const { model } = await client.send("DOM.getBoxModel", {
          nodeId: pseudo.nodeId,
        });
        const box = quadBox(model.border);
        boxes.push({
          note,
          pseudo: pseudo.pseudoType ?? "",
          box,
          margin: Math.min(
            box.x,
            box.y,
            figure.width - box.x - box.width,
            figure.height - box.y - box.height,
          ),
        });
      }
    }
    return boxes;
  } finally {
    await client.detach();
  }
}

/** What the PNG actually holds. A figure that came out blank, half-drawn, or
 * at the wrong size is the other way this script fails quietly. */
async function inspect(png: Buffer, figure: Figure): Promise<string> {
  const meta = await sharp(png).metadata();
  const expected = {
    width: figure.width * SCALE,
    height: figure.height * SCALE,
  };
  if (meta.width !== expected.width || meta.height !== expected.height) {
    throw new Error(
      `${figure.out}: ${meta.width}x${meta.height}, expected ${expected.width}x${expected.height}`,
    );
  }
  const { data, info } = await sharp(png).raw().toBuffer({
    resolveWithObject: true,
  });
  const colors = new Set<number>();
  for (let i = 0; i < data.length; i += info.channels) {
    colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
  }
  if (colors.size < 2) throw new Error(`${figure.out}: blank image`);
  if (png.length < 20_000) {
    throw new Error(`${figure.out}: only ${png.length} bytes`);
  }
  const detail = (await sharp(png).stats()).channels
    .map(
      (channel) =>
        `${channel.min}-${channel.max} mean ${channel.mean.toFixed(1)}`,
    )
    .join(", ");
  return `${meta.width}x${meta.height} ${colors.size} colours, ${Math.round(png.length / 1024)}KB, ${detail}`;
}

/** Renders one figure, having measured it first. */
async function renderFigure(page: Page, figure: Figure): Promise<void> {
  await page.setViewportSize({ width: figure.width, height: figure.height });
  await page.setContent(render(figure.html), { waitUntil: "load" });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([
      document.fonts.load('400 16px "Shantell Sans"'),
      document.fonts.load('400 15px "JetBrains Mono"'),
      document.fonts.load('700 15px "JetBrains Mono"'),
    ]);
  });

  const measured = await measure(page, figure);
  const pseudos = await pseudoBoxes(page, figure);
  const boxes = [
    ...measured.annotations.map(({ note, box, margin }) => ({
      note,
      what: "element",
      box,
      margin,
    })),
    ...pseudos.map(({ note, pseudo, box, margin }) => ({
      note,
      what: `::${pseudo}`,
      box,
      margin,
    })),
  ];
  for (const { note, what, box, margin } of boxes) {
    if (margin < MIN_MARGIN) {
      throw new Error(
        `${figure.out}: ${what} of "${note}" is ${format(box)}, ${margin.toFixed(1)}px from the edge`,
      );
    }
  }
  for (const { note, label } of measured.annotations) {
    if (label !== JSON.stringify(note)) {
      throw new Error(
        `${figure.out}: "${note}" draws the label ${label || "nothing"}`,
      );
    }
  }
  if (
    measured.scrollWidth > figure.width ||
    measured.scrollHeight > figure.height
  ) {
    throw new Error(
      `${figure.out}: ${measured.scrollWidth}x${measured.scrollHeight} overflows ${figure.width}x${figure.height}`,
    );
  }
  if (!measured.labelFont || !measured.receiptFont) {
    throw new Error(
      `${figure.out}: fonts shantell=${measured.labelFont} mono=${measured.receiptFont}`,
    );
  }

  const png = await page.screenshot({
    clip: { x: 0, y: 0, width: figure.width, height: figure.height },
  });
  await writeFile(figure.out, png);

  console.info(
    `${figure.out} ${figure.width}x${figure.height} at ${SCALE}x, clip 0,0 ${figure.width}x${figure.height}`,
  );
  for (const {
    note,
    tag,
    box,
    margin,
    label,
    labelFont,
  } of measured.annotations) {
    console.info(
      `  ${tag} "${note}" ${format(box)} margin ${margin.toFixed(1)}px label ${label} in ${labelFont}`,
    );
    for (const pseudo of pseudos.filter((p) => p.note === note)) {
      console.info(
        `    ::${pseudo.pseudo} ${format(pseudo.box)} margin ${pseudo.margin.toFixed(1)}px`,
      );
    }
  }
  console.info(
    `  scroll ${measured.scrollWidth}x${measured.scrollHeight} fonts shantell=${measured.labelFont} mono=${measured.receiptFont}`,
  );
  console.info(`  ${await inspect(png, figure)}`);
}

const annotationsCss = await readFile(ANNOTATIONS, "utf8");
const labelFont = await readFile(LABEL_FONT);
const receiptFont = await readFile(RECEIPT_FONT);
const receipt = parseYaml(await readFile(RECEIPT, "utf8")) as Receipt;
const category = mealsCategory(await readFile(CATEGORIES, "utf8"));

const FIGURES: Figure[] = [
  receiptFigure(receipt, category),
  receiptPortraitFigure(receipt, category),
];

const browser = await chromium.launch();
const context = await browser.newContext({ deviceScaleFactor: SCALE });
const page = await context.newPage();

for (const figure of FIGURES) {
  await renderFigure(page, figure);
}

await browser.close();
