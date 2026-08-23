import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "tesseract.js";

// The real OCR flow runs against a stubbed tesseract engine: ocrImage (real)
// calls createWorker → worker.recognize(), so controlling the recognize
// result drives the "what did OCR produce" input to the fallback decision.
vi.mock("tesseract.js", () => ({ createWorker: vi.fn() }));

import { extractFromImage } from "~/lib/receipt-ocr.server";

/**
 * OCR-first fallback contract for image receipts. "auto" runs local OCR and
 * only spends a vision call when the OCR text can't name a total or the text
 * extraction comes back weak — photocopies/glare/skew are the vision cases,
 * cheap OCR handles everything else. The LLM is stubbed: the request body's
 * user content is a plain string for text calls, an array with an image_url
 * for vision calls.
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

describe("receipt OCR-first fallback (auto)", () => {
  it("extracts from usable OCR text without calling vision", async () => {
    mockOcr("ACME CAFE\nMONTEREY PARK CA\nTOTAL $12.50");

    const { result } = await extractFromImage({
      accountId: "ocr-fallback-a",
      buffer: RECEIPT_PNG,
      mime: "image/png",
    });

    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]!.image).toBe(false);
    expect(llmCalls[0]!.text).toContain("TOTAL");
    expect(result.merchant).toBe("OcrCorp");
  });

  it("falls back to vision when OCR text is empty", async () => {
    mockOcr("");

    const { result } = await extractFromImage({
      accountId: "ocr-fallback-b",
      buffer: RECEIPT_PNG,
      mime: "image/png",
    });

    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]!.image).toBe(true);
    expect(result.merchant).toBe("VisionCorp");
    expect(result.amount).toBe("9.73");
  });

  it("falls back to vision when OCR text cannot name a total", async () => {
    // Plenty of text but no amount-like line — the photocopy signature.
    mockOcr("ACME CAFE\nMONTEREY PARK CA\n*** UNREADABLE ***");

    const { result } = await extractFromImage({
      accountId: "ocr-fallback-c",
      buffer: RECEIPT_PNG,
      mime: "image/png",
    });

    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]!.image).toBe(true);
    expect(result.merchant).toBe("VisionCorp");
  });

  it("falls back to vision when the text extraction is weak", async () => {
    // OCR text parses a total, but the model decides it isn't a receipt —
    // the vision call gets the final say.
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
          answer({ merchant: "VisionCorp", amount: "9.73" }),
          { status: 200 },
        );
      }
      return new Response(
        answer({ is_receipt: false, merchant: "", amount: "" }),
        { status: 200 },
      );
    });

    const { result } = await extractFromImage({
      accountId: "ocr-fallback-d",
      buffer: RECEIPT_PNG,
      mime: "image/png",
    });

    expect(llmCalls).toHaveLength(2);
    expect(llmCalls[0]!.image).toBe(false);
    expect(llmCalls[1]!.image).toBe(true);
    expect(result.merchant).toBe("VisionCorp");
  });

  it("keeps the weak OCR result when the vision fallback errors", async () => {
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
        return new Response("boom", { status: 500 });
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
    expect(llmCalls[1]!.image).toBe(true); // vision was attempted
    expect(result.isReceipt).toBe(false); // weak text result preserved
  });

  it("stores octet-stream images with a displayable mime", async () => {
    // Phones attach screenshots as application/octet-stream with a UUID
    // filename — the bytes are sniffed so the stored receipt renders.
    mockOcr("ACME CAFE\nTOTAL $12.50");

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
