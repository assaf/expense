import type { Metadata } from "sharp";

/**
 * Receipt image normalization for storage (resize + light compression),
 * applied at save time so every stored receipt (manual upload, paste,
 * inbound email, PDF render) is bounded in size.
 *
 * Kept dependency-free (no app imports, erasable TypeScript only) so the
 * one-off backfill script (`scripts/compress-images.ts`) can reuse it with
 * plain `node` type stripping, no tsx needed.
 *
 * Rules:
 *  - Not decodable by sharp, GIF (animation), or SVG → pass through
 *    unchanged (returns null).
 *  - Already a JPEG within size limits → pass through (no generational
 *    quality loss on re-save).
 *  - Everything else decodable → EXIF-rotate, scale to fit within
 *    STORED_IMAGE_MAX_WIDTH × STORED_IMAGE_MAX_HEIGHT (never upscale),
 *    flatten alpha onto white (receipts are paper), re-encode as JPEG.
 *    JPEG is chosen over WebP because PDFKit (report export) can embed
 *    JPEG/PNG but not WebP, and browsers serve it everywhere.
 *
 * Returns `{ buffer, mime }` with the re-encoded bytes + "image/jpeg",
 * or `null` when the input should be stored as-is.
 */

export const STORED_IMAGE_MAX_WIDTH = 1024;
const STORED_IMAGE_MAX_HEIGHT = 4096;
const STORED_IMAGE_QUALITY = 85;

/**
 * Pixel cap for decoding user-supplied images. Sharp's own default
 * (268MP) lets a crafted image decode to ~1GB of pixel buffer, a
 * single-request memory spike in a serverless function. 2^26 (64MP)
 * covers phone photos and DPI scans while bounding the worst-case decode
 * to a few hundred MB; larger inputs fail fast at decode instead of
 * allocating.
 */
const MAX_DECODE_PIXELS = 67_108_864; // 2^26

/** Raster formats we will resize + re-encode. Anything else passes through. */
const RASTER_FORMATS = new Set([
  "jpeg",
  "png",
  "webp",
  "heif",
  "tiff",
  "avif",
  "bmp",
]);

export async function normalizeStoredImage(
  buffer: Buffer,
): Promise<{ buffer: Buffer; mime: string } | null> {
  const sharp = (await import("sharp")).default;
  let meta: Metadata | undefined;
  try {
    meta = await sharp(buffer, {
      limitInputPixels: MAX_DECODE_PIXELS,
    }).metadata();
  } catch {
    return null; // not decodable by sharp (or over the pixel cap): pass through
  }
  if (!meta.width || !meta.height || !meta.format) return null;
  if (!RASTER_FORMATS.has(meta.format)) return null; // gif/svg/other
  if (
    meta.format === "jpeg" &&
    meta.width <= STORED_IMAGE_MAX_WIDTH &&
    meta.height <= STORED_IMAGE_MAX_HEIGHT
  ) {
    return null; // already small + compressed, so store as-is
  }

  // .rotate() applies EXIF orientation so re-encoding never flips sideways.
  try {
    const out = await resizeToJpeg(buffer, {
      maxWidth: STORED_IMAGE_MAX_WIDTH,
      maxHeight: STORED_IMAGE_MAX_HEIGHT,
      quality: STORED_IMAGE_QUALITY,
      flatten: true,
    });
    return { buffer: out, mime: "image/jpeg" };
  } catch {
    return null; // decode failed (e.g. over the pixel cap): pass through
  }
}

/**
 * Downscale an image to fit within `maxWidth` (never upscale). Returns the
 * original buffer when it already fits, or null when sharp can't decode it;
 * callers treat null as "pass through unchanged". Shared by the OCR and
 * attachment-image normalizers in receipt-ocr.server.ts.
 */
export async function resizeIfWider(
  buffer: Buffer,
  maxWidth: number,
): Promise<Buffer | null> {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(buffer, {
    limitInputPixels: MAX_DECODE_PIXELS,
  })
    .metadata()
    .catch(() => null);
  if (!meta?.width) return null; // not decodable by sharp
  if (meta.width <= maxWidth) return buffer; // already fits, no re-encode
  try {
    return await sharp(buffer, {
      limitInputPixels: MAX_DECODE_PIXELS,
    })
      .resize({ width: maxWidth, withoutEnlargement: true })
      .toBuffer();
  } catch {
    return null; // decode failed (e.g. over the pixel cap): pass through
  }
}

/**
 * Resize + re-encode an image as JPEG: EXIF-rotate, fit inside the given box
 * (never upscale), optionally flatten alpha onto white. Shared by the storage
 * normalizer (saveImage) and the list thumbnail route.
 */
export async function resizeToJpeg(
  buffer: Buffer,
  opts: {
    maxWidth: number;
    maxHeight: number;
    quality?: number;
    flatten?: boolean;
  },
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  let img = sharp(buffer, { limitInputPixels: MAX_DECODE_PIXELS })
    .rotate()
    .resize({
      width: opts.maxWidth,
      height: opts.maxHeight,
      fit: "inside",
      withoutEnlargement: true,
    });
  if (opts.flatten) img = img.flatten({ background: "#ffffff" });
  return img.jpeg({ quality: opts.quality ?? 80, mozjpeg: true }).toBuffer();
}
