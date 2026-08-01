import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { renderEmailImage } from "~/lib/email-render.server";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** The PNG must be real and contain actual ink (dark pixels). */
async function expectInk(png: Buffer): Promise<void> {
  expect(png.length).toBeGreaterThan(2_000);
  const stats = await sharp(png).stats();
  const min = Math.min(...stats.channels.slice(0, 3).map((c) => c.min));
  expect(min).toBeLessThan(200);
}

describe("renderEmailImage (headless chromium)", () => {
  it("renders a rich HTML email to a non-blank 640px PNG", async () => {
    const png = await renderEmailImage(
      '<html><head></head><body style="font-family:Arial,sans-serif"><h1 style="color:#ea580c">Your order #10492</h1><table border="1"><tr><td>Item</td><td>$10.00</td></tr></table><p style="background:#f3f4f6;padding:8px">Thanks!</p></body></html>',
    );
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(640);
    await expectInk(png);
  });

  it("resolves cid: images through the resolver", async () => {
    const png = await renderEmailImage(
      '<html><body><img src="cid:logo1" width="16" height="16"><p>Receipt</p></body></html>',
      {
        resolveImage: async (cid) =>
          cid === "logo1" ? { buffer: TINY_PNG, mime: "image/png" } : null,
      },
    );
    await expectInk(png);
  });

  it("never fetches external images (network blocked)", async () => {
    const started = Date.now();
    const png = await renderEmailImage(
      '<html><body><img src="https://example.com/track.png"><p>Done</p></body></html>',
    );
    expect(Date.now() - started).toBeLessThan(15_000);
    await expectInk(png);
  });

  it("rejects empty and oversized HTML", async () => {
    await expect(renderEmailImage("")).rejects.toThrow(/empty/i);
    await expect(renderEmailImage("  \n ")).rejects.toThrow(/empty/i);
    await expect(
      renderEmailImage(`<p>${"x".repeat(4_000_001)}</p>`),
    ).rejects.toThrow(/too large/i);
  });
});
