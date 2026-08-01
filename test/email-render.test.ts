import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  renderEmailImage,
  renderTextEmail,
  collectRemoteImageUrls,
  stripForwardedText,
  stripForwardHeader,
} from "~/lib/email-render.server";

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

  it("inlines remote images through the fetcher when provided", async () => {
    const fetched: string[] = [];
    const png = await renderEmailImage(
      '<html><body><img src="https://cdn.example.com/logo.png" width="8" height="8"><p>Receipt</p></body></html>',
      {
        fetchRemoteImage: async (url) => {
          fetched.push(url);
          return { buffer: TINY_PNG, mime: "image/png" };
        },
      },
    );
    expect(fetched).toEqual(["https://cdn.example.com/logo.png"]);
    await expectInk(png);
  });

  it("leaves unfetchable remote images for the browser to drop", async () => {
    const png = await renderEmailImage(
      '<html><body><img src="https://cdn.example.com/broken.png"><p>Done</p></body></html>',
      { fetchRemoteImage: async () => null },
    );
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

describe("collectRemoteImageUrls", () => {
  it("collects img src, srcset, and CSS url() references but not links", () => {
    const html = [
      '<img src="https://cdn.example.com/a.png">',
      '<img srcset="https://cdn.example.com/b.png 1x, https://cdn.example.com/c.png 2x">',
      "<div style=\"background-image: url('https://cdn.example.com/d.png')\">",
      "<style>.x{background:url(https://cdn.example.com/e.png)}</style>",
      '<a href="https://cdn.example.com/not-an-image">link</a>',
    ].join("");
    expect(collectRemoteImageUrls(html)).toEqual([
      "https://cdn.example.com/a.png",
      "https://cdn.example.com/b.png",
      "https://cdn.example.com/c.png",
      "https://cdn.example.com/d.png",
      "https://cdn.example.com/e.png",
    ]);
  });

  it("returns [] for html with no remote images", () => {
    expect(collectRemoteImageUrls("<p>no images</p>")).toEqual([]);
  });
});

describe("stripForwardedText (plain-text forwards)", () => {
  it("removes the Fastmail forward header block", () => {
    const text = [
      "— Assaf",
      "",
      "----- Original message -----",
      "From: zai <receipts@stripe.com>",
      "To: assaf@labnotes.org",
      "Subject: Your zai receipt [#1909-8795]",
      "Date: Thursday, July 30, 2026 5:15 PM",
      "",
      "Receipt from zai",
      "Amount paid $10.00",
    ].join("\n");
    const out = stripForwardedText(text);
    expect(out).not.toContain("Original message");
    expect(out).not.toContain("From:");
    expect(out).not.toContain("Subject:");
    expect(out).toContain("Receipt from zai");
    expect(out).toContain("Amount paid $10.00");
  });

  it("removes Gmail-style forward blocks", () => {
    const text = [
      "---------- Forwarded message ----------",
      "From: X <x@y.com>",
      "Date: Tue, Jun 2, 2026 at 3:14 PM",
      "Subject: Your order receipt",
      "To: me@gmail.com",
      "",
      "Order total $42.50",
    ].join("\n");
    const out = stripForwardedText(text);
    expect(out).not.toContain("Forwarded message");
    expect(out).not.toContain("From:");
    expect(out).toBe("Order total $42.50");
  });

  it("removes Apple Mail / iOS forward blocks", () => {
    expect(
      stripForwardedText(
        "Begin forwarded message:\nFrom: A <a@b.com>\nDate: Jun 2, 2026\n\nReceipt body",
      ),
    ).toBe("Receipt body");
  });

  it("leaves text without a forward marker untouched", () => {
    const text = "Receipt from Acme\nTotal $12.00";
    expect(stripForwardedText(text)).toBe(text);
  });

  it("does not strip receipt content that follows the header block", () => {
    const text = [
      "Begin forwarded message:",
      "From: A <a@b.com>",
      "Date: Jun 2, 2026",
      "",
      "Line one of the receipt",
      "From: a follow-up line inside the receipt",
    ].join("\n");
    const out = stripForwardedText(text);
    expect(out).toContain("Line one of the receipt");
    expect(out).toContain("a follow-up line inside the receipt");
  });
});

describe("stripForwardHeader (html forwards)", () => {
  it("removes the Fastmail forward header elements", () => {
    const html = [
      "<html><body>",
      "<div>— Assaf</div>",
      "<div>----- Original message -----</div>",
      "<div>From: zai &lt;receipts@stripe.com&gt;</div>",
      "<div>To:&nbsp;assaf@labnotes.org</div>",
      "<div>Subject: Your zai receipt [#1909-8795]</div>",
      "<div>Date: Thursday, July 30, 2026 5:15 PM</div>",
      "<div><br></div>",
      '<div type="cite"><h1>Receipt from zai</h1></div>',
      "</body></html>",
    ].join("\n");
    const out = stripForwardHeader(html);
    expect(out).not.toContain("Original message");
    expect(out).not.toContain("From: zai");
    expect(out).not.toContain("Subject:");
    expect(out).toContain("Receipt from zai");
  });

  it("removes Gmail-style header divs inside a gmail_quote", () => {
    const html = [
      '<div class="gmail_quote">',
      '<div dir="ltr">---------- Forwarded message ----------<br></div>',
      '<div dir="ltr"><b>From:</b> X &lt;x@y.com&gt;<br></div>',
      '<div dir="ltr"><b>Date:</b> Tue, Jun 2, 2026<br></div>',
      '<div dir="ltr"><b>Subject:</b> hi<br></div>',
      "<div><br></div>",
      "<div>Order total $42.50</div>",
      "</div>",
    ].join("\n");
    const out = stripForwardHeader(html);
    expect(out).not.toContain("Forwarded message");
    expect(out).not.toContain("From:");
    expect(out).toContain("Order total $42.50");
  });

  it("returns the html unchanged when there is no forward block", () => {
    const html = "<html><body><h1>Your receipt</h1></body></html>";
    expect(stripForwardHeader(html)).toBe(html);
  });
});
