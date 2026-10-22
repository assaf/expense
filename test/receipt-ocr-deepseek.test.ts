import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createWorker } from "tesseract.js";

vi.mock("tesseract.js", () => ({ createWorker: vi.fn() }));

// Vision-only mode: no local OCR, so a model failure must accept the
// receipt with empty fields instead of failing the capture.
vi.mock("~/lib/env", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, RECEIPT_OCR_MODE: "deepseek" };
});

import { extractFromImage } from "~/lib/receipt-ocr.server";

const createWorkerMock = vi.mocked(createWorker);
const RECEIPT_PNG = readFileSync("test/fixtures/images/ralphs.png");

const answer = (fields: Record<string, unknown>) =>
  JSON.stringify({
    choices: [
      {
        message: {
          content: JSON.stringify({
            is_receipt: true,
            merchant: "VisionCorp",
            amount: "9.73",
            currency: "USD",
            description: "",
            category: "",
            report: "",
            confidence: "high",
            notes: "",
            ...fields,
          }),
        },
      },
    ],
  });

let visionStatus: number;
let visionBody: string;

beforeEach(() => {
  visionStatus = 200;
  visionBody = answer({});
  createWorkerMock.mockReset();
  vi.stubGlobal("fetch", async () => {
    return new Response(visionBody, { status: visionStatus });
  });
});

describe("receipt vision-only mode (deepseek)", () => {
  it("reads the image with vision, never running local OCR", async () => {
    const { result } = await extractFromImage({
      accountId: "ocr-deepseek-a",
      buffer: RECEIPT_PNG,
      mime: "image/png",
    });

    expect(result.merchant).toBe("VisionCorp");
    expect(result.amount).toBe("9.73");
    expect(createWorkerMock).not.toHaveBeenCalled();
  });

  it("accepts the receipt with empty fields when the vision model fails", async () => {
    visionStatus = 402;

    const { result } = await extractFromImage({
      accountId: "ocr-deepseek-b",
      buffer: RECEIPT_PNG,
      mime: "image/png",
    });

    // No local OCR in this mode, so nothing is read — but the capture
    // still succeeds instead of failing.
    expect(result.isReceipt).toBe(true);
    expect(result.merchant).toBe("");
    expect(result.amount).toBe("");
    expect(result.confidence).toBe("low");
    expect(result.notes).toContain("receipt AI was unavailable");
    expect(createWorkerMock).not.toHaveBeenCalled();
  });
});
