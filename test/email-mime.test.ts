import { describe, expect, it } from "vitest";
import PostalMime from "postal-mime";
import { buildRfc822Message, encodeHeader } from "~/lib/email-mime.server";
import { emailShell } from "~/lib/email-layout.server";

function decodeBase64(text: string): string {
  return Buffer.from(text.replace(/\s+/g, ""), "base64").toString("utf8");
}

describe("encodeHeader", () => {
  it("passes plain ASCII through", () => {
    expect(encodeHeader("Your receipt")).toBe("Your receipt");
  });

  it("RFC 2047-encodes non-ASCII (emoji subjects)", () => {
    const out = encodeHeader("⚠️ Receipt accepted");
    expect(out).toMatch(/^=\?UTF-8\?B\?/);
    expect(
      Buffer.from(out.match(/B\?(.+)\?=/)?.[1] ?? "", "base64").toString(),
    ).toBe("⚠️ Receipt accepted");
  });
});

describe("buildRfc822Message", () => {
  it("builds a multipart/alternative message with encoded UTF-8 parts", () => {
    const raw = buildRfc822Message({
      fromName: "Expense",
      fromEmail: "receipts@labnotes.org",
      to: "assaf@arkin.me",
      subject: "⚠️ Receipt accepted — $5.00",
      html: "<p>Thanks!</p>",
      text: "Thanks!",
    });
    const text = raw.toString("utf8");

    expect(text).toMatch(/^Date: .+GMT/);
    expect(text).toMatch(/From: Expense <receipts@labnotes.org>/);
    expect(text).toMatch(/To: assaf@arkin.me/);
    expect(text).toMatch(/Message-ID: <exp-/);
    expect(text).toMatch(/MIME-Version: 1.0/);
    expect(text).toMatch(/multipart\/alternative/);
    expect(text).toMatch(/Content-Transfer-Encoding: base64/);

    const html = decodeBase64(
      text.match(
        /text\/html[\s\S]*?base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n--/,
      )![1]!,
    );
    expect(html).toBe("<p>Thanks!</p>");
  });

  it("sets In-Reply-To and References when replying", () => {
    const raw = buildRfc822Message({
      fromName: "",
      fromEmail: "receipts@labnotes.org",
      to: "assaf@arkin.me",
      subject: "Re: Your receipt",
      html: "<p>hi</p>",
      inReplyTo: "<orig123@example.com>",
    });
    const text = raw.toString("utf8");
    expect(text).toMatch(/In-Reply-To: <orig123@example.com>/);
    expect(text).toMatch(/References: <orig123@example.com>/);
  });

  it("carries List-Unsubscribe headers and blocks header injection", () => {
    const raw = buildRfc822Message({
      fromName: "Expense",
      fromEmail: "receipts@labnotes.org",
      to: "assaf@arkin.me",
      subject: "News",
      html: "<p>hi</p>",
      headers: {
        "List-Unsubscribe": "<https://expense.labnotes.org/unsubscribe/t>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        // Header-name injection: a hostile key must be dropped whole.
        "X-Evil\r\nBcc: victim@example.com": "v",
        // Header-value injection: CRLF stripped.
        "X-Expense-Test": "ok\r\nBcc: victim@example.com",
      },
    });
    const text = raw.toString("utf8");
    expect(text).toMatch(
      /List-Unsubscribe: <https:\/\/expense\.labnotes\.org\/unsubscribe\/t>/,
    );
    const lines = text.split("\r\n");
    expect(lines).toContain(
      "List-Unsubscribe: <https://expense.labnotes.org/unsubscribe/t>",
    );
    expect(lines).toContain(
      "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    );
    // The hostile name is dropped whole; the CRLF-bearing value is
    // flattened onto one header line, so it can't smuggle a real Bcc.
    expect(lines.some((l) => l.startsWith("Bcc:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("X-Evil"))).toBe(false);
    expect(lines).toContainEqual(
      expect.stringMatching(/^X-Expense-Test: ok Bcc:/),
    );
  });

  it("includes attachments as base64 multipart/mixed parts", () => {
    const raw = buildRfc822Message({
      fromName: "Expense",
      fromEmail: "receipts@labnotes.org",
      to: "assaf@arkin.me",
      subject: "Receipt",
      html: "<p>hi</p>",
      attachments: [
        {
          content: Buffer.from("fake-image-bytes").toString("base64"),
          filename: "receipt.png",
        },
      ],
    });
    const text = raw.toString("utf8");
    expect(text).toMatch(/multipart\/mixed/);
    expect(text).toMatch(/filename="receipt.png"/);
    expect(text).toMatch(/Content-Disposition: attachment/);
    // The attachment's base64 decodes back to the original bytes.
    const decoded = Buffer.from(
      text
        .match(
          /name="receipt\.png"[\s\S]*?base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n--/,
        )![1]!
        .replace(/\s+/g, ""),
      "base64",
    );
    expect(decoded.toString()).toBe("fake-image-bytes");
  });

  it("declares the attachment's contentType when provided", () => {
    const raw = buildRfc822Message({
      fromName: "Expense",
      fromEmail: "receipts@labnotes.org",
      to: "assaf@arkin.me",
      subject: "Receipt",
      html: "<p>hi</p>",
      attachments: [
        {
          content: Buffer.from("png-bytes").toString("base64"),
          filename: "photo.png",
          contentType: "image/png",
        },
      ],
    });
    const text = raw.toString("utf8");
    expect(text).toMatch(/Content-Type: image\/png; name="photo\.png"/);
  });

  it("shows a part with a contentId inline, in the HTML's own related", async () => {
    const raw = buildRfc822Message({
      fromName: "Expense",
      fromEmail: "receipts@labnotes.org",
      to: "assaf@arkin.me",
      subject: "Receipt",
      html: '<p>hi</p><img src="cid:receipt-1@expense.local">',
      attachments: [
        {
          content: Buffer.from("jpeg-bytes").toString("base64"),
          filename: "receipt.jpg",
          contentType: "image/jpeg",
          contentId: "receipt-1@expense.local",
        },
      ],
    });
    const text = raw.toString("utf8");
    // The HTML and the image it references share one multipart/related
    // (RFC 2387: type names the root, here the HTML), nested inside the
    // alternative. An inline image in a sibling multipart/mixed part is
    // listed as an attachment instead of rendered where the HTML puts it.
    expect(text).toMatch(/^Content-Type: multipart\/alternative;/m);
    expect(text).toMatch(
      /Content-Type: multipart\/related; type="text\/html"; boundary="/,
    );
    expect(text).not.toMatch(/multipart\/mixed/);

    const parsed = await PostalMime.parse(raw);
    expect(parsed.html).toContain('src="cid:receipt-1@expense.local"');
    expect(
      parsed.attachments.map((a) => [
        a.filename,
        a.mimeType,
        a.disposition,
        a.contentId,
      ]),
    ).toEqual([
      ["receipt.jpg", "image/jpeg", "inline", "<receipt-1@expense.local>"],
    ]);
  });

  it("keeps a file to open outside the inline image's related part", async () => {
    const raw = buildRfc822Message({
      fromName: "Expense",
      fromEmail: "receipts@labnotes.org",
      to: "assaf@arkin.me",
      subject: "Receipt",
      html: '<img src="cid:receipt-1@expense.local">',
      attachments: [
        {
          content: Buffer.from("jpeg-bytes").toString("base64"),
          filename: "receipt.jpg",
          contentType: "image/jpeg",
          contentId: "receipt-1@expense.local",
        },
        {
          content: Buffer.from("pdf-bytes").toString("base64"),
          filename: "scan.pdf",
          contentType: "application/pdf",
        },
      ],
    });
    // A message that has both: multipart/mixed wraps the alternative (whose
    // HTML half is the related), and the PDF is its peer.
    const text = raw.toString("utf8");
    expect(text).toMatch(/^Content-Type: multipart\/mixed;/m);

    const parsed = await PostalMime.parse(raw);
    expect(
      parsed.attachments.map((a) => [a.filename, a.disposition, a.contentId]),
    ).toEqual([
      ["receipt.jpg", "inline", "<receipt-1@expense.local>"],
      ["scan.pdf", "attachment", undefined],
    ]);
  });

  it("strips CR/LF from To and In-Reply-To (header injection guard)", () => {
    const raw = buildRfc822Message({
      fromName: "Expense",
      fromEmail: "receipts@labnotes.org",
      to: "assaf@arkin.me\r\nBcc: pwn@evil.com",
      subject: "Receipt",
      html: "<p>hi</p>",
      inReplyTo: "<orig@example.com>\r\nBcc: pwn2@evil.com",
    });
    const text = raw.toString("utf8");
    // No injected header line survives.
    expect(text).not.toMatch(/\r?\nBcc:/);
    // The To header is the sanitized value (CR/LF → space, trimmed).
    expect(text).toMatch(/^To: assaf@arkin\.me Bcc: pwn@evil\.com$/m);
    expect(text).toMatch(
      /^In-Reply-To: <orig@example\.com> Bcc: pwn2@evil\.com$/m,
    );
  });

  it("escapes the email shell title (user data can reach headings)", () => {
    const html = emailShell({
      title: "<b>Office</b><script>alert(1)</script>",
      body: "<p>x</p>",
    });
    expect(html).toContain("&lt;b&gt;Office&lt;/b&gt;&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  it("uses CRLF line endings throughout", () => {
    const raw = buildRfc822Message({
      fromName: "Expense",
      fromEmail: "receipts@labnotes.org",
      to: "assaf@arkin.me",
      subject: "Test",
      html: "<p>hi</p>",
    });
    const text = raw.toString("utf8");
    expect(text).not.toMatch(/(^|\r\n)[^\r\n]*\n/); // no bare LF
  });
});
