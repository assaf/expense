import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The worker race: two OCR calls starting together must not both spawn a
// tesseract worker — the singleton caches the creation PROMISE, so the
// second caller awaits the first one's creation instead of racing it (the
// loser of that race used to be overwritten in the module variable and
// leaked its thread and wasm heap).
vi.mock("tesseract.js", () => ({
  createWorker: vi.fn(async () => ({
    recognize: vi.fn(async () => ({ data: { text: "" } })),
    terminate: vi.fn(async () => {}),
  })),
}));

import { getOcrWorker, resetOcrWorker } from "~/lib/receipt-ocr.server";

describe("tesseract worker lifecycle", () => {
  beforeEach(() => {
    resetOcrWorker();
  });

  it("creates the worker once under concurrent calls", async () => {
    const { createWorker } = await import("tesseract.js");
    await Promise.all([getOcrWorker(), getOcrWorker(), getOcrWorker()]);
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it("builds a fresh worker after a reset", async () => {
    await getOcrWorker();
    resetOcrWorker();
    await getOcrWorker();
    const { createWorker } = await import("tesseract.js");
    expect(createWorker).toHaveBeenCalledTimes(2);
  });
});
