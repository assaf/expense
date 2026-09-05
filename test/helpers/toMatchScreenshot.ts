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
  tolerance?: number;
  antialiasingTolerance?: number;
  /** Fraction of differing pixels still accepted even when looks-same
   * reports unequal — absorbs sub-pixel rendering noise without masking
   * real layout regressions, which move far more pixels. */
  maxDiffPixelRatio?: number;
}

declare module "vitest" {
  interface Assertion<R extends void | Promise<void> = void, T = unknown> {
    toMatchScreenshot(options?: ScreenshotOptions): Promise<void>;
  }
}

expect.extend({
  async toMatchScreenshot(
    page: Page,
    options?: ScreenshotOptions,
  ): Promise<{ message: () => string; pass: boolean }> {
    if (process.env.CI) {
      return {
        message: () => "Skipping screenshot comparison in CI",
        pass: true,
      };
    }
    if (!options?.name) {
      return {
        message: () => "toMatchScreenshot requires a name",
        pass: false,
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

    const result = await looksSame(await readFile(baselinePath), screenshot, {
      antialiasingTolerance: options.antialiasingTolerance ?? 0,
      createDiffImage: true,
      ignoreAntialiasing: true,
      ignoreCaret: true,
      tolerance: options.tolerance ?? DEFAULT_TOLERANCE,
      strict: false,
    });
    const { equal, differentPixels, totalPixels, diffImage } = result;
    const diffRatio = totalPixels ? differentPixels / totalPixels : 0;
    const withinPixelBudget =
      options.maxDiffPixelRatio !== undefined &&
      diffRatio <= options.maxDiffPixelRatio;

    if (!equal && !withinPixelBudget) {
      const newPath = path.resolve(SCREENSHOTS_DIR, `${options.name}.new.png`);
      const diffPath = path.resolve(
        SCREENSHOTS_DIR,
        `${options.name}.diff.png`,
      );
      await mkdir(path.dirname(newPath), { recursive: true });
      if (diffImage) await diffImage.save(diffPath);
      await writeFile(newPath, screenshot);
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
