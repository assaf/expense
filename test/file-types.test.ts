import { describe, expect, it } from "vitest";
import { detectImageMime, isPdf, isImage } from "~/lib/file-types";

describe("isPdf", () => {
  it("matches by mime type (with and without parameters)", () => {
    expect(isPdf({ mime: "application/pdf" })).toBe(true);
    expect(isPdf({ mime: "application/pdf; charset=utf-8" })).toBe(true);
    expect(isPdf({ mime: "Application/PDF" })).toBe(true);
  });

  it("rejects non-PDF mime types", () => {
    expect(isPdf({ mime: "image/png" })).toBe(false);
    expect(isPdf({ mime: "text/plain" })).toBe(false);
  });

  it("matches by filename extension", () => {
    expect(isPdf({ originalName: "receipt.pdf" })).toBe(true);
    expect(isPdf({ originalName: "invoice.PDF" })).toBe(true);
  });

  it("rejects non-PDF filename extensions", () => {
    expect(isPdf({ originalName: "photo.png" })).toBe(false);
    expect(isPdf({ originalName: "data.csv" })).toBe(false);
  });

  it("matches by PDF magic bytes in the buffer", () => {
    expect(isPdf({ buffer: Buffer.from("%PDF-1.4\n%...") })).toBe(true);
    expect(isPdf({ buffer: Buffer.from("%PDF-2.0") })).toBe(true);
  });

  it("rejects non-PDF magic bytes", () => {
    expect(isPdf({ buffer: Buffer.from("\x89PNG\r\n") })).toBe(false);
    expect(isPdf({ buffer: Buffer.from("hello") })).toBe(false);
    expect(isPdf({ buffer: Buffer.from("") })).toBe(false);
  });

  it("returns true when any signal matches, even if others disagree", () => {
    // A file named .pdf with an image mime: the .pdf name is enough.
    expect(isPdf({ mime: "image/png", originalName: "fake.pdf" })).toBe(true);
    // A file with PDF mime: the mime is enough regardless of name.
    expect(isPdf({ mime: "application/pdf", originalName: "photo.jpg" })).toBe(
      true,
    );
  });
});

describe("isImage", () => {
  it("matches by image/ mime prefix", () => {
    expect(isImage({ mime: "image/png" })).toBe(true);
    expect(isImage({ mime: "image/jpeg" })).toBe(true);
    expect(isImage({ mime: "image/heic" })).toBe(true);
    expect(isImage({ mime: "image/tiff" })).toBe(true);
    expect(isImage({ mime: "image/webp" })).toBe(true);
    expect(isImage({ mime: "image/bmp" })).toBe(true);
  });

  it("rejects non-image mime types", () => {
    expect(isImage({ mime: "application/pdf" })).toBe(false);
    expect(isImage({ mime: "text/html" })).toBe(false);
  });

  it("matches by filename extension", () => {
    expect(isImage({ originalName: "receipt.png" })).toBe(true);
    expect(isImage({ originalName: "photo.JPG" })).toBe(true);
    expect(isImage({ originalName: "scan.tiff" })).toBe(true);
    expect(isImage({ originalName: "frame.heic" })).toBe(true);
    expect(isImage({ originalName: "logo.webp" })).toBe(true);
    expect(isImage({ originalName: "export.bmp" })).toBe(true);
    expect(isImage({ originalName: "photo.avif" })).toBe(true);
  });

  it("rejects .pdf and other non-image extensions", () => {
    expect(isImage({ originalName: "doc.pdf" })).toBe(false);
    expect(isImage({ originalName: "data.csv" })).toBe(false);
    expect(isImage({ originalName: "noext" })).toBe(false);
  });

  it("detects images by magic bytes (extension-less octet-stream)", () => {
    const png = Buffer.from("89504e470d0a1a0a" + "00".repeat(16), "hex");
    const jpeg = Buffer.from("ffd8ffe000104a464946" + "00".repeat(16), "hex");
    const pdf = Buffer.from("%PDF-1.7\n", "utf8");
    expect(isImage({ buffer: png })).toBe(true);
    expect(isImage({ buffer: jpeg })).toBe(true);
    expect(isImage({ buffer: pdf })).toBe(false);
    // A phone attachment: octet-stream mime, UUID filename, PNG bytes.
    expect(
      isImage({
        mime: "application/octet-stream",
        originalName: "no-ext",
        buffer: png,
      }),
    ).toBe(true);
    // Octet-stream + no extension + PDF bytes is a PDF, not an image.
    expect(
      isImage({
        mime: "application/octet-stream",
        originalName: "no-ext",
        buffer: pdf,
      }),
    ).toBe(false);
  });

  it("detectImageMime names the real type", () => {
    const png = Buffer.from("89504e470d0a1a0a" + "00".repeat(16), "hex");
    const gif = Buffer.from("474946383961" + "00".repeat(16), "hex");
    const webp = Buffer.from("52494646" + "00".repeat(4) + "57454250", "hex");
    expect(detectImageMime(png)).toBe("image/png");
    expect(detectImageMime(gif)).toBe("image/gif");
    expect(detectImageMime(webp)).toBe("image/webp");
    expect(detectImageMime(Buffer.from("hello world"))).toBeNull();
  });

  it("returns false when no signal is present", () => {
    expect(isImage({})).toBe(false);
  });
});
