import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { renderEmailImage, renderTextEmail } from "~/lib/email-render.server";

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
      renderEmailImage("<p>" + "x".repeat(4_000_001) + "</p>"),
    ).rejects.toThrow(/too large/i);
  });

  it("clamps emails with long unbroken <pre> lines to the viewport width", async () => {
    const png = await renderEmailImage(
      "<!doctype html><html><body><pre>" +
        "x".repeat(3_000) +
        "</pre><p>done</p></body></html>",
    );
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(640);
    await expectInk(png);
  });

  it("renders doctype-less HTML fragments in standards mode", async () => {
    const png = await renderEmailImage(
      '<table width="100%"><tr><td>Cell</td></tr></table><p>More</p>',
    );
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(640);
    await expectInk(png);
  });
});

describe("renderTextEmail (plain-text emails)", () => {
  it("renders text in a 600px column with 24px margins and 14pt text", async () => {
    const png = await renderTextEmail(
      "THE COFFEE ROASTERY\n2134 Sunset Blvd, Los Angeles, CA\n\nTOTAL 23.21",
      {
        subject: "Your receipt",
        from: "receipts@coffeeroastery.example",
      },
    );
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(648); // 600px column + 24px margins each side
    // Both 24px margins are pure white.
    for (const left of [0, meta.width! - 24]) {
      const strip = await sharp(
        await sharp(png)
          .extract({
            left,
            top: 0,
            width: 24,
            height: Math.min(meta.height!, 200),
          })
          .png()
          .toBuffer(),
      ).stats();
      const min = Math.min(...strip.channels.slice(0, 3).map((c) => c.min));
      expect(min).toBeGreaterThanOrEqual(250);
    }
    await expectInk(png);
  });

  it("wraps long unbroken lines instead of overflowing the column", async () => {
    const png = await renderTextEmail(`Long link: ${"a".repeat(400)}\n\nEnd`);
    const meta = await sharp(png).metadata();
    // Right margin stays white → nothing overflowed the 600px column.
    const right = await sharp(
      await sharp(png)
        .extract({
          left: meta.width! - 24,
          top: 0,
          width: 24,
          height: Math.min(meta.height!, 300),
        })
        .png()
        .toBuffer(),
    ).stats();
    const min = Math.min(...right.channels.slice(0, 3).map((c) => c.min));
    expect(min).toBeGreaterThanOrEqual(250);
  });

  it("rejects empty text", async () => {
    await expect(renderTextEmail("")).rejects.toThrow(/empty/i);
    await expect(renderTextEmail("   \n ")).rejects.toThrow(/empty/i);
  });
});
