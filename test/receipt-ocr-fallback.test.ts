import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "tesseract.js";

// The real OCR flow runs against a stubbed tesseract engine: ocrImage (real)
// calls createWorker → worker.recognize(), so controlling the recognize
// result drives the "what did OCR produce" input to the fallback decision.
vi.mock("tesseract.js", () => ({ createWorker: vi.fn() }));

import { extractFromImage } from "~/lib/receipt-ocr.server";

/**
 * Vision-first fallback contract for image receipts. "auto" reads the image
 * with the LLM first — no local OCR CPU on the happy path — and runs
 * tesseract only when the model can't name a total + merchant or the
 * provider errors: photocopies/glare/skew are the vision cases anyway. The
 * LLM is stubbed: the request body's user content is a plain string for text
 * calls, an array with an image_url for vision calls.
 */

const createWorkerMock = vi.mocked(createWorker);
const RECEIPT_PNG = readFileSync("test/fixtures/images/ralphs.png");

type LlmCall = { text: string | null; image: boolean };

let llmCalls: LlmCall[] = [];
/** Per-call override: keyed by call index — used to fail the vision call. */
let failOn: Record<number, boolean> = {};
// The OCR engine is created lazily inside extractFromImage, so the recognize
// stub reads this variable at call time rather than being configured after.
let ocrText = "";

const answer = (overrides: Record<string, unknown>) =>
  JSON.stringify({
    choices: [
      {
        message: {
          content: JSON.stringify({
            is_receipt: true,
            merchant: "OcrCorp",
            amount: "12.50",
            currency: "USD",
            description: "",
            category: "",
            report: "",
            confidence: "high",
            notes: "",
            ...overrides,
          }),
        },
      },
    ],
  });

function mockOcr(text: string): void {
  ocrText = text;
}

beforeEach(() => {
  llmCalls = [];
  failOn = {};
  createWorkerMock.mockReset();
  ocrText = "";
  createWorkerMock.mockImplementation(
    async () =>
      ({
        recognize: vi.fn(async () => ({ data: { text: ocrText } })),
        terminate: vi.fn(),
      }) as never,
  );
  vi.stubGlobal("fetch", async (_url: unknown, init: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as {
      messages: Array<{ content: unknown }>;
    };
    const user = body.messages.at(-1)!;
    const image = Array.isArray(user.content);
    const callIndex = llmCalls.length;
    llmCalls.push({ text: image ? null : (user.content as string), image });
    if (failOn[callIndex]) {
      return new Response("boom", { status: 500 });
    }
    const overrides = image ? { merchant: "VisionCorp", amount: "9.73" } : {};
    return new Response(answer(overrides), { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("receipt vision-first fallback (auto)", () => {
  it("reads the image with vision without running local OCR", async () => {
    // The happy path: one vision call, zero tesseract CPU.
    const { result } = await extractFromImage({
      accountId: "ocr-fallback-a",
      buffer: RECEIPT_PNG,
      mime: "image/png",
    });

    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]!.image).toBe(true);
    expect(createWorkerMock).not.toHaveBeenCalled();
    expect(result.merchant).toBe("VisionCorp");
    expect(result.amount).toBe("9.73");
  });

  it("falls back to OCR when the vision call errors", async () => {
    mockOcr("ACME CAFE\nMONTEREY PARK CA\nTOTAL $12.50");
    failOn = { 0: true }; // the vision call fails

    const { result } = await extractFromImage({
      accountId: "ocr-fallback-b",
      buffer: RECEIPT_PNG,
      mime: "image/png",
    });

    expect(llmCalls).toHaveLength(2);
    expect(llmCalls[0]!.image).toBe(true); // vision was attempted
    expect(llmCalls[1]!.image).toBe(false); // then OCR text extraction
    expect(createWorkerMock).toHaveBeenCalled();
    expect(result.merchant).toBe("OcrCorp");
    expect(result.amount).toBe("12.50");
  });

  it("falls back to OCR when the vision extraction is weak", async () => {
    // The model reads the image but decides it isn't a receipt — the OCR
    // text names a total, so its solid extraction gets the final say.
    mockOcr("ACME CAFE\nTOTAL $12.50");
    vi.stubGlobal("fetch", async (_url: unknown, init: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as {
        messages: Array<{ content: unknown }>;
      };
      const user = body.messages.at(-1)!;
      const image = Array.isArray(user.content);
      llmCalls.push({
        text: image ? null : (user.content as string),
        image,
      });
      if (image) {
        return new Response(
          answer({ is_receipt: false, merchant: "", amount: "" }),
          { status: 200 },
        );
      }
      return new Response(answer({ merchant: "OcrCorp", amount: "12.50" }), {
        status: 200,
      });
    });

    const { result } = await extractFromImage({
      accountId: "ocr-fallback-c",
      buffer: RECEIPT_PNG,
      mime: "image/png",
    });

    expect(llmCalls).toHaveLength(2);
    expect(llmCalls[0]!.image).toBe(true);
    expect(llmCalls[1]!.image).toBe(false);
    expect(result.merchant).toBe("OcrCorp");
  });

  it("keeps the weak vision result when OCR comes back empty", async () => {
    // The model saw a receipt but couldn't name a total+merchant (a
    // photocopy); tesseract finds nothing either — the weak vision result
    // stands rather than failing the capture.
    mockOcr("");
    vi.stubGlobal("fetch", async (_url: unknown, init: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as {
        messages: Array<{ content: unknown }>;
      };
      const user = body.messages.at(-1)!;
      const image = Array.isArray(user.content);
      llmCalls.push({
        text: image ? null : (user.content as string),
        image,
      });
      return new Response(
        answer({ merchant: "", amount: "", confidence: "low" }),
        { status: 200 },
      );
    });

    const { result } = await extractFromImage({
      accountId: "ocr-fallback-d",
      buffer: RECEIPT_PNG,
      mime: "image/png",
    });

    expect(llmCalls).toHaveLength(1);
    expect(createWorkerMock).not.toHaveBeenCalled();
    expect(result.isReceipt).toBe(true);
    expect(result.merchant).toBe("");
  });

  it("keeps the weak vision result when the OCR extraction is weak too", async () => {
    // Vision: a receipt, but no total read. OCR text parses a total, yet
    // its extraction denies a receipt — the vision verdict (it saw the
    // image) wins over the weaker OCR one.
    mockOcr("ACME CAFE\nTOTAL $12.50");
    vi.stubGlobal("fetch", async (_url: unknown, init: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as {
        messages: Array<{ content: unknown }>;
      };
      const user = body.messages.at(-1)!;
      const image = Array.isArray(user.content);
      llmCalls.push({
        text: image ? null : (user.content as string),
        image,
      });
      if (image) {
        return new Response(
          answer({ merchant: "", amount: "", confidence: "low" }),
          { status: 200 },
        );
      }
      return new Response(
        answer({ is_receipt: false, merchant: "", amount: "" }),
        { status: 200 },
      );
    });

    const { result } = await extractFromImage({
      accountId: "ocr-fallback-e",
      buffer: RECEIPT_PNG,
      mime: "image/png",
    });

    expect(llmCalls).toHaveLength(2);
    expect(llmCalls[0]!.image).toBe(true);
    expect(llmCalls[1]!.image).toBe(false); // OCR was attempted
    expect(result.isReceipt).toBe(true); // vision verdict kept
    expect(result.merchant).toBe("");
  });

  it("stores octet-stream images with a displayable mime", async () => {
    // Phones attach screenshots as application/octet-stream with a UUID
    // filename — the bytes are sniffed so the stored receipt renders.
    const { stored } = await extractFromImage({
      accountId: "ocr-fallback-g",
      buffer: RECEIPT_PNG,
      mime: "application/octet-stream",
    });

    expect(stored.mime).toBe("image/png");
  });

  it("rethrows when vision fails and OCR produced nothing", async () => {
    mockOcr("");
    failOn = { 0: true }; // the vision call fails

    await expect(
      extractFromImage({
        accountId: "ocr-fallback-f",
        buffer: RECEIPT_PNG,
        mime: "image/png",
      }),
    ).rejects.toThrow();
  });
});
