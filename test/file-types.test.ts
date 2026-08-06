import { describe, expect, it } from "vitest";
import { isPdf, isImage } from "~/lib/file-types";

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

  it("returns false when no signal is present", () => {
    expect(isPdf({})).toBe(false);
  });

  it("returns true when any signal matches, even if others disagree", () => {
    // A file named .pdf with an image mime — the .pdf name is enough.
    expect(isPdf({ mime: "image/png", originalName: "fake.pdf" })).toBe(true);
    // A file with PDF mime — the mime is enough regardless of name.
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

  it("returns false when no signal is present", () => {
    expect(isImage({})).toBe(false);
  });
});
