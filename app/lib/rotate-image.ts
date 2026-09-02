/**
 * Rotate a receipt image by a multiple of 90°, entirely in the browser.
 *
 * The source is what the user already sees: an uploaded File/Blob is decoded
 * through an <img> (browsers apply EXIF orientation at decode time), or the
 * already-displayed <img> element for a stored receipt. That matters because
 * stored JPEGs may carry an EXIF orientation tag: rotating the raw bytes on
 * the server would double-apply what the browser shows, while this path
 * rotates exactly the pixels on screen.
 *
 * The result is a re-encoded JPEG with alpha flattened onto white (receipts
 * are paper), the same storage shape the save pipeline normalizes uploads
 * to, so no EXIF survives to disagree with the pixels. The caller uploads
 * the returned File through the ordinary draft flow; nothing is stored
 * until the expense is saved.
 */

/** Re-encode `name` with a .jpg extension to match the JPEG output. */
function jpgName(name: string): string {
  return `${name.replace(/\.[a-z0-9]+$/i, "")}.jpg`;
}

/** Decode a Blob through an <img> so EXIF orientation is applied. */
async function decodeBlob(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  img.onload = () => resolve();
  img.onerror = () => reject(new Error("Image could not be decoded"));
  img.src = url;
  try {
    await promise;
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function rotateReceiptImage(
  source: Blob | HTMLImageElement,
  degrees: number,
  name: string,
): Promise<File> {
  if (degrees % 90 !== 0) {
    throw new Error("Rotation must be a multiple of 90 degrees");
  }
  const quarter = (((degrees % 360) + 360) % 360) / 90;
  const img = source instanceof Blob ? await decodeBlob(source) : source;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw new Error("Image has no pixels to rotate");
  const swap = quarter % 2 === 1;
  const canvas = document.createElement("canvas");
  canvas.width = swap ? h : w;
  canvas.height = swap ? w : h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((quarter * Math.PI) / 2);
  ctx.drawImage(img, -w / 2, -h / 2);
  const { promise, resolve } = Promise.withResolvers<Blob | null>();
  canvas.toBlob(resolve, "image/jpeg", 0.85);
  const blob = await promise;
  if (!blob) throw new Error("Rotated image could not be encoded");
  return new File([blob], jpgName(name), { type: "image/jpeg" });
}
