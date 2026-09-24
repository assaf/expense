import { describe, expect, it } from "vite-plus/test";
import { confirmationEmail } from "~/lib/email-confirmation.server";

/**
 * The confirmation a receipt import sends back. The image half is the point
 * of these tests: a receipt the client can render is shown inline (an <img>
 * whose cid: URL matches the part's Content-ID), anything else stays a file
 * to open, and the two can never drift because the builder returns both.
 */
const BASE = {
  expenseId: "01J8Z9K2Q0W3E4R5T6Y7U8I9OP",
  date: "2026-07-10",
  merchant: "Blue Bottle Coffee",
  amount: "18.50",
  category: "Meals",
  report: "Q3",
  description: "",
  notes: "",
  missing: [],
};

const JPEG = {
  content: Buffer.from("jpeg-bytes").toString("base64"),
  filename: "receipt.jpg",
  contentType: "image/jpeg",
};

const PDF = {
  content: Buffer.from("pdf-bytes").toString("base64"),
  filename: "invoice.pdf",
  contentType: "application/pdf",
};

describe("confirmationEmail", () => {
  it("shows an image receipt inline, above the details", () => {
    const { html, text, attachments } = confirmationEmail({
      ...BASE,
      receipt: JPEG,
    });
    const part = attachments![0]!;
    expect(part.contentType).toBe("image/jpeg");
    expect(part.contentId).toBeTruthy();
    expect(html).toContain(`<img src="cid:${part.contentId}"`);
    // Above the field table: the receipt is the first thing read, and the
    // first image is what a client shows as the preview.
    expect(html.indexOf("<img")).toBeLessThan(html.indexOf("<table"));
    // The HTML renders it; a text-only reader gets the name of the part.
    expect(html).not.toContain("Receipt image attached");
    expect(text).toContain("Receipt image attached: receipt.jpg");
  });

  it("attaches a receipt it cannot render inline", () => {
    const { html, text, attachments } = confirmationEmail({
      ...BASE,
      receipt: PDF,
    });
    // No Content-ID: a part nothing references stays a plain attachment,
    // where an <img> pointing at bytes the client cannot decode would show
    // a broken image.
    expect(attachments).toEqual([PDF]);
    expect(html).not.toContain("<img");
    expect(text).not.toContain("Receipt image attached");
    // A text-only reader still learns what came with the message.
    expect(text).toContain("Original receipt attached: invoice.pdf");
  });

  it("inlines the stored render when the original cannot be rendered", () => {
    const { html, text, attachments } = confirmationEmail({
      ...BASE,
      receipt: PDF,
      preview: JPEG,
    });
    // Two parts: the render shown inline, the original still attached.
    const [inlinePart, filePart] = attachments!;
    expect(inlinePart!.filename).toBe("receipt.jpg");
    expect(inlinePart!.contentType).toBe("image/jpeg");
    expect(inlinePart!.contentId).toBeTruthy();
    expect(filePart).toEqual(PDF);
    expect(html).toContain(`<img src="cid:${inlinePart!.contentId}"`);
    expect(html).toContain('alt="Receipt"');
    expect(text).toContain("Receipt image attached: receipt.jpg");
    expect(text).toContain("Original receipt attached: invoice.pdf");
  });

  it("shows the saved render, not a second copy of the original image", () => {
    const saved = {
      content: Buffer.from("saved-render").toString("base64"),
      filename: "receipt.jpg",
      contentType: "image/jpeg",
    };
    const original = {
      content: Buffer.from("original-photo").toString("base64"),
      filename: "IMG_1234.jpg",
      contentType: "image/jpeg",
    };
    const { attachments, html } = confirmationEmail({
      ...BASE,
      receipt: original,
      preview: saved,
    });
    // One part, not two: the render the expense was saved with is what the
    // reader sees, so the original image is neither inlined again nor
    // attached as a duplicate.
    expect(attachments).toHaveLength(1);
    expect(attachments![0]!.content).toBe(saved.content);
    expect(attachments![0]!.contentId).toBeTruthy();
    expect(html).toContain("<img");
  });

  it("falls back to the original image when no render was stored", () => {
    const { attachments, html } = confirmationEmail({
      ...BASE,
      receipt: JPEG,
    });
    expect(attachments).toHaveLength(1);
    expect(attachments![0]!.filename).toBe("receipt.jpg");
    expect(attachments![0]!.contentId).toBeTruthy();
    expect(html).toContain("<img");
  });

  it("leaves an image format clients do not render inline alone", () => {
    const { html, attachments } = confirmationEmail({
      ...BASE,
      receipt: {
        content: Buffer.from("heic-bytes").toString("base64"),
        filename: "receipt.heic",
        contentType: "image/heic",
      },
    });
    expect(attachments![0]!.contentId).toBeUndefined();
    expect(html).not.toContain("<img");
  });

  it("inlines the render for a body-source receipt (no file to attach)", () => {
    const { html, text, attachments } = confirmationEmail({
      ...BASE,
      preview: JPEG,
    });
    // One inline part and nothing attached: the render is the image, and the
    // original body text is NOT quoted back below it — the image shows the
    // receipt, so a copy of the text adds nothing.
    expect(attachments).toHaveLength(1);
    expect(attachments![0]!.contentId).toBeTruthy();
    expect(html).toContain(`<img src="cid:${attachments![0]!.contentId}"`);
    expect(html).not.toContain("Original receipt");
    expect(text).toContain("Receipt image attached: receipt.jpg");
    expect(text).not.toContain("Original receipt attached");
  });

  it("carries nothing at all when no image is available", () => {
    const { html, attachments } = confirmationEmail({ ...BASE });
    expect(attachments).toBeUndefined();
    expect(html).not.toContain("<img");
    expect(html).not.toContain("Original receipt");
  });
});
