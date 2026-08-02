/**
 * Decode a Vite `?inline` asset import to raw bytes. Vite returns the asset
 * as a base64 string (older versions as a `data:` URI) — normalize to raw
 * bytes either way. Used for the bundled font files embedded as @font-face
 * data URIs in the email/text receipt renderers.
 */
export function decodeInlineAsset(asset: string): Buffer {
  return Buffer.from(
    asset.includes("base64,") ? asset.split("base64,")[1]! : asset,
    "base64",
  );
}
