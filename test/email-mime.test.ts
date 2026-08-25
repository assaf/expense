import { describe, expect, it } from "vitest";
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
