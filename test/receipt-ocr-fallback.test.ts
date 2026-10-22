import { readFileSync } from "node:fs";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { createWorker } from "tesseract.js";

// The real OCR flow runs against a stubbed tesseract engine: ocrImage (real)
// calls createWorker → worker.recognize(), so controlling the recognize
// result drives the "what did OCR produce" input to the fallback decision.
vi.mock("tesseract.js", () => ({ createWorker: vi.fn() }));

import { extractFromImage } from "~/lib/receipt-ocr.server";

/**
 * Vision-first fallback contract for image receipts. "auto" reads the image
 * with the LLM (no local OCR CPU), and runs tesseract only when the
 * provider errors: photocopies/glare/skew are the vision cases anyway, so a
 * weak vision result stands. When the provider does error, the fallback is
 * local only — tesseract reads the image and the deterministic amount parse
 * fills the total, with no second model call, so a receipt is still
 * captured. The LLM is stubbed: the request body's user content is a plain
 * string for text calls, an array with an image_url for vision calls.
 */

const createWorkerMock = vi.mocked(createWorker);
const RECEIPT_PNG = readFileSync("test/fixtures/images/ralphs.png");

type LlmCall = { text: string | null; image: boolean };

let llmCalls: LlmCall[] = [];
/** Per-call override: keyed by call index; used to fail the vision call. */
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

  it("falls back to local OCR when the vision call errors", async () => {
    mockOcr("ACME CAFE\nMONTEREY PARK CA\nTOTAL $12.50");
    failOn = { 0: true }; // the vision call fails

    const { result } = await extractFromImage({
      accountId: "ocr-fallback-b",
      buffer: RECEIPT_PNG,
      mime: "image/png",
    });

    // The failing provider is not asked a second time: tesseract reads the
    // image and the amount is parsed locally, so the capture still files.
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]!.image).toBe(true); // only the vision call
    expect(createWorkerMock).toHaveBeenCalled();
    expect(result.isReceipt).toBe(true);
    expect(result.merchant).toBe("");
    expect(result.amount).toBe("12.50");
    expect(result.confidence).toBe("low");
    expect(result.notes).toContain("receipt AI was unavailable");
  });

  it("keeps a weak vision verdict without running OCR", async () => {
    // The model reads the image but decides it isn't a receipt, so no OCR
    // rescue, even though tesseract would have named a total: CPU only on
    // provider error.
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
      return new Response(
        answer({ is_receipt: false, merchant: "", amount: "" }),
        { status: 200 },
      );
    });

    const { result } = await extractFromImage({
      accountId: "ocr-fallback-c",
      buffer: RECEIPT_PNG,
      mime: "image/png",
    });

    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]!.image).toBe(true);
    expect(createWorkerMock).not.toHaveBeenCalled();
    expect(result.isReceipt).toBe(false);
    expect(result.merchant).toBe("");
  });

  it("keeps a weak vision receipt without running OCR", async () => {
    // The model saw a receipt but couldn't name a total+merchant (a
    // photocopy). Tesseract would likely miss it too, so the weak result
    // stands rather than spending CPU or failing the capture.
    mockOcr("ACME CAFE\nTOTAL $12.50"); // tesseract WOULD have read it
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

  it("stores octet-stream images with a displayable mime", async () => {
    // Phones attach screenshots as application/octet-stream with a UUID
    // filename; the bytes are sniffed so the stored receipt renders.
    const { stored } = await extractFromImage({
      accountId: "ocr-fallback-g",
      buffer: RECEIPT_PNG,
      mime: "application/octet-stream",
    });

    expect(stored.mime).toBe("image/png");
  });

  it("still accepts the receipt when vision fails and OCR read nothing", async () => {
    mockOcr("");
    failOn = { 0: true }; // the vision call fails

    const { result } = await extractFromImage({
      accountId: "ocr-fallback-f",
      buffer: RECEIPT_PNG,
      mime: "image/png",
    });

    // Nothing was read, but the capture still succeeds: the image is the
    // receipt, and the fields are left for the user to fill in.
    expect(result.isReceipt).toBe(true);
    expect(result.merchant).toBe("");
    expect(result.amount).toBe("");
    expect(result.confidence).toBe("low");
  });

  it("still accepts the receipt when OCR itself fails after a vision error", async () => {
    createWorkerMock.mockRejectedValue(new Error("tesseract CDN unreachable"));
    failOn = { 0: true }; // the vision call fails

    const { result } = await extractFromImage({
      accountId: "ocr-fallback-h",
      buffer: RECEIPT_PNG,
      mime: "image/png",
    });

    // Both readers are down; the image is still the receipt.
    expect(result.isReceipt).toBe(true);
    expect(result.merchant).toBe("");
    expect(result.amount).toBe("");
    expect(result.confidence).toBe("low");
  });
});
