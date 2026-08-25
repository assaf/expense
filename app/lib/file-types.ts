/**
 * File-type detection for uploaded receipt files (images + PDFs). Shared by
 * the image routes, the OCR pipeline, and the inbound-email attachment
 * scoring, so each check lives in exactly one place.
 *
 * Each predicate takes whichever of mime / filename / bytes the caller has:
 *  - mime: tolerates parameters ("application/pdf; charset=…") via splitting
 *  - filename: case-insensitive extension match
 *  - bytes: PDF magic bytes, covering mislabeled uploads (e.g. a browser
 *    that reports no type)
 * Any provided signal may match; pass what you have.
 */

/** True when the mime type is a PDF (parameters after ";" ignored). */
function isPdfMime(mime: string): boolean {
  return mime.split(";")[0]!.trim().toLowerCase() === "application/pdf";
}

/** True when the filename ends in .pdf (case-insensitive). */
function isPdfName(name: string): boolean {
  return /\.pdf$/i.test(name);
}

/** True when the buffer starts with the PDF magic bytes ("%PDF-"). */
function isPdfMagicBytes(buffer: Buffer): boolean {
  return (
    buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-"
  );
}

/** True when the input is a PDF: by mime, filename, or magic bytes. */
export function isPdf(input: {
  buffer?: Buffer;
  mime?: string;
  originalName?: string;
}): boolean {
  if (input.mime !== undefined && isPdfMime(input.mime)) return true;
  if (input.originalName !== undefined && isPdfName(input.originalName)) {
    return true;
  }
  if (input.buffer !== undefined && isPdfMagicBytes(input.buffer)) return true;
  return false;
}

/** File extensions the app treats as image receipts. Single source of truth
 * for extension-based image detection; add a format here (not in a second
 * regex) when a new image type is supported. The storage mime map in
 * images.server.ts covers the narrower subset it re-encodes/stores by
 * mime; the wider set here is what detection accepts. */
const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "heic",
  "heif",
  "bmp",
  "tif",
  "tiff",
  "avif",
] as const;

const IMAGE_NAME_RE = new RegExp(`\\.(${IMAGE_EXTENSIONS.join("|")})$`, "i");

/** Sniff the real image mime from the leading bytes: "image/png",
 * "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/tiff",
 * "image/heic" or "image/avif". Null when the bytes aren't a known image.
 * Covers attachments served as application/octet-stream (phones attach
 * screenshots with UUID filenames and no declared type). */
export function detectImageMime(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  const hex = buffer.subarray(0, 4).toString("hex");
  if (hex === "89504e47") return "image/png";
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (buffer.subarray(0, 4).toString("latin1").startsWith("GIF8"))
    return "image/gif";
  if (
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  if (buffer.subarray(0, 2).toString("latin1") === "BM") return "image/bmp";
  const tiffHex = buffer.subarray(0, 4).toString("hex");
  if (tiffHex === "49492a00" || tiffHex === "4d4d002a") return "image/tiff";
  if (buffer.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("latin1");
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand))
      return "image/heic";
    if (["avif", "avis"].includes(brand)) return "image/avif";
  }
  return null;
}

/** True when the input is an image, by mime, filename, or magic bytes. */
export function isImage(input: {
  mime?: string;
  originalName?: string;
  buffer?: Buffer;
}): boolean {
  if (
    input.mime !== undefined &&
    input.mime.toLowerCase().startsWith("image/")
  ) {
    return true;
  }
  if (
    input.originalName !== undefined &&
    IMAGE_NAME_RE.test(input.originalName)
  ) {
    return true;
  }
  if (input.buffer !== undefined && detectImageMime(input.buffer) !== null) {
    return true;
  }
  return false;
}

/** True when a dropped/pasted/uploaded file matches the upload input:
 * any image mime, or a PDF by mime or filename. Client-side counterpart
 * to the server's isImage/isPdf checks; used by the drag-drop targets. */
export function isReceiptFile(file: File): boolean {
  return (
    file.type.startsWith("image/") ||
    file.type === "application/pdf" ||
    isPdfName(file.name)
  );
}
