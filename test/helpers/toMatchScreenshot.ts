/**
 * Visual-regression matcher for the suite screenshots (adapted from
 * rentail/test/helpers/toMatchScreenshot.ts): the first run writes the
 * baseline into screenshots/ (committed); later runs compare against it
 * with looks-same and fail on drift, leaving screenshots/<name>.new.png
 * (the new capture) and screenshots/<name>.diff.png (highlighted diff)
 * next to the baseline for review. Review/accept them with
 * `pnpm screenshots:review`. Skipped in CI.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import looksSame from "looks-same";
import sharp from "sharp";
import type { Page } from "playwright";
import { expect } from "vitest";

const SCREENSHOTS_DIR = path.resolve("screenshots");

/** looks-same's ΔE threshold: small enough to catch real color shifts,
 * loose enough to ignore compression-level noise. */
const DEFAULT_TOLERANCE = 2.3;

interface ScreenshotOptions {
  /** Screenshot name, without extension; nested names map to subdirs. */
  name: string;
  fullPage?: boolean;
}

declare module "vitest" {
  interface Assertion<R extends void | Promise<void> = void, T = unknown> {
    toMatchScreenshot(options?: ScreenshotOptions): Promise<void>;
  }
}

expect.extend({
  async toMatchScreenshot(
    page: Page,
    options: ScreenshotOptions,
  ): Promise<{ message: () => string; pass: boolean }> {
    if (process.env.CI) {
      return {
        message: () => "Skipping screenshot comparison in CI",
        pass: true,
      };
    }
    // Give the page a moment to finish uploading images and rendering.
    await page.waitForTimeout(500);
    // A webfont still loading swaps glyphs mid-capture; wait for the
    // settled font set or text-region diffs will flag phantom drift.
    await page.evaluate(() => document.fonts.ready);
    const baselinePath = path.resolve(SCREENSHOTS_DIR, `${options.name}.png`);
    const screenshot = await page.screenshot({
      fullPage: options.fullPage ?? false,
      animations: "disabled",
      caret: "hide",
      scale: "css",
      type: "png",
    });

    try {
      await access(baselinePath, 4); // R_OK
    } catch {
      await mkdir(path.dirname(baselinePath), { recursive: true });
      await writeFile(baselinePath, screenshot);
      return {
        message: () => `Baseline screenshot created at ${baselinePath}.`,
        pass: true,
      };
    }
    // createDiffImage stays on: its result carries the different/total
    // pixel counts for the failure message (the review image is ours).
    const result = await looksSame(await readFile(baselinePath), screenshot, {
      tolerance: DEFAULT_TOLERANCE,
      createDiffImage: true,
      ignoreAntialiasing: true,
      ignoreCaret: true,
      strict: false,
    });
    const { equal, differentPixels, totalPixels } = result;
    const diffRatio = totalPixels ? differentPixels / totalPixels : 0;

    if (!equal) {
      const newPath = path.resolve(SCREENSHOTS_DIR, `${options.name}.new.png`);
      const diffPath = path.resolve(
        SCREENSHOTS_DIR,
        `${options.name}.diff.png`,
      );
      await mkdir(path.dirname(newPath), { recursive: true });
      await writeFile(newPath, screenshot);
      // Best effort: a broken diff image must not mask the drift finding.
      try {
        await saveDiffImage(await readFile(baselinePath), screenshot, diffPath);
      } catch {
        // Leave the previous diff.png (or none) in place.
      }
      return {
        message: () =>
          `Screenshot differs from baseline: ${options.name} ` +
          `(${differentPixels}/${totalPixels} pixels, ${(diffRatio * 100).toFixed(3)}% differ). ` +
          `See ${diffPath} and ${newPath}; review with \`pnpm screenshots:review\`.`,
        pass: false,
      };
    }
    return { message: () => "Image matches baseline", pass: true };
  },
});

/** Render the drift for human review: identical pixels ghost at 80% over
 * white (visible context, muted), changed pixels stand out in solid red.
 * Full page, no cropping or magnification — the red is the signal. Best
 * effort only; the equal/count decision above stays with looks-same. */
const DIFF_CHANNEL_THRESHOLD = 8;

export async function saveDiffImage(
  baseline: Buffer,
  current: Buffer,
  diffPath: string,
): Promise<void> {
  const [ref, cur] = await Promise.all([
    sharp(baseline).raw().toBuffer({ resolveWithObject: true }),
    sharp(current).raw().toBuffer({ resolveWithObject: true }),
  ]);
  const { width: curW, height: curH, channels: curC } = cur.info;
  const overlapW = Math.min(ref.info.width, curW);
  const overlapH = Math.min(ref.info.height, curH);
  const out = Buffer.alloc(curW * curH * 3, 255);
  for (let y = 0; y < curH; y++) {
    for (let x = 0; x < curW; x++) {
      const i = (y * curW + x) * curC;
      // Outside the overlap the baseline has no say: it changed.
      let changed = x >= overlapW || y >= overlapH;
      for (let c = 0; c < 3 && !changed; c++) {
        const j = (y * ref.info.width + x) * ref.info.channels;
        if (
          Math.abs(cur.data[i + c] - ref.data[j + c]) > DIFF_CHANNEL_THRESHOLD
        ) {
          changed = true;
        }
      }
      const o = (y * curW + x) * 3;
      if (changed) {
        out[o] = 255;
        out[o + 1] = 0;
        out[o + 2] = 0;
      } else {
        // 80% of the capture over white: identical content stays readable,
        // red is the only saturated color on the page.
        out[o] = 255 - Math.round((255 - cur.data[i]) * 0.2);
        out[o + 1] = 255 - Math.round((255 - cur.data[i + 1]) * 0.2);
        out[o + 2] = 255 - Math.round((255 - cur.data[i + 2]) * 0.2);
      }
    }
  }
  await sharp(out, { raw: { width: curW, height: curH, channels: 3 } })
    .png()
    .toFile(diffPath);
}

/** Delete stale .new/.diff/.git artifacts (recursively) before a run, so
 * a pass leaves no review leftovers from earlier failures. */
export async function removeDiffImages(): Promise<void> {
  function scan(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(full);
      else if (
        entry.name.endsWith(".new.png") ||
        entry.name.endsWith(".diff.png") ||
        entry.name.endsWith(".git.png")
      ) {
        unlinkSync(full);
      }
    }
  }
  try {
    scan(SCREENSHOTS_DIR);
  } catch {
    // No screenshots dir yet — nothing to clean.
  }
}
