import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { LLM_MODEL, LLM_VISION_MODEL } from "~/lib/env";
import { warrantyExtractionCacheKey } from "~/lib/db/extraction-cache";
import {
  buildWarrantyExtraction,
  extractWarrantyFields,
  productFromFileName,
} from "~/lib/warranty-ai.server";
import { FENCE_SENTINEL } from "~/lib/prompt-fence.server";
import { TEST_ACCOUNT_ID, testPrisma } from "./helpers/seedTestData";

/**
 * Warranty document extraction: the request the app actually sends (fetched
 * through the shared chat-completions transport), how an answer is turned
 * into stored fields, and the cache that keeps a re-dropped document from
 * paying for a second read.
 *
 * LLM_API_KEY/LLM_BASE_URL/LLM_VISION_MODEL are pinned in
 * vitest.main.config test.env, since CI has no .env and env.ts reads them at
 * import time.
 */

const MODEL_ANSWER = JSON.stringify({
  choices: [
    {
      message: {
        content:
          '{"merchant":"Williams Sonoma","product":"Espresso machine",' +
          '"value":"1,299.00","purchased_at":"2026-07-15",' +
          '"expires_at":"2028-07-15","terms":"Two years parts and labor.",' +
          '"confidence":"high","notes":""}',
      },
    },
  ],
});

interface CapturedBody {
  model: string;
  max_tokens: number;
  response_format?: { type: string };
  thinking?: unknown;
  messages: Array<{ role: string; content: unknown }>;
}

let calls: CapturedBody[] = [];

/** A tiny real PNG: the image path decodes it (sharp) before the call. */
async function tinyPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 60,
      height: 30,
      channels: 3,
      background: { r: 250, g: 250, b: 250 },
    },
  })
    .png()
    .toBuffer();
}

beforeEach(async () => {
  calls = [];
  // Only the chat-completions request is captured; pdf.js fetches standard
  // font data from a CDN while extracting a PDF's text layer, and that
  // request has no business being counted as a model call.
  vi.stubGlobal("fetch", async (url: unknown, init?: { body?: string }) => {
    if (!String(url).includes("/chat/completions")) {
      return new Response(null, { status: 404 });
    }
    calls.push(JSON.parse(init?.body ?? "{}") as CapturedBody);
    return new Response(MODEL_ANSWER, { status: 200 });
  });
  await testPrisma.receiptExtraction.deleteMany({
    where: { accountId: TEST_ACCOUNT_ID },
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await testPrisma.receiptExtraction.deleteMany({
    where: { accountId: TEST_ACCOUNT_ID },
  });
});

describe("buildWarrantyExtraction", () => {
  it("reads the model's fields into a storable warranty", () => {
    const result = buildWarrantyExtraction(
      '{"merchant":"Williams Sonoma","product":"Espresso machine",' +
        '"value":"$1,299.00","purchased_at":"2026-07-15",' +
        '"expires_at":"2028-07-15","terms":"Two years parts and labor.",' +
        '"confidence":"high","notes":"no serial number"}',
    );
    expect(result).toEqual({
      merchant: "Williams Sonoma",
      product: "Espresso machine",
      value: "1299.00",
      purchasedAt: "2026-07-15",
      expiresAt: "2028-07-15",
      terms: "Two years parts and labor.",
      confidence: "high",
      notes: "no serial number",
    });
  });

  it("drops a date that isn't a calendar day and a price the column can't hold", () => {
    const result = buildWarrantyExtraction(
      '{"product":"Toaster","value":"99999999999",' +
        '"purchased_at":"March 2027","expires_at":"2026-02-30"}',
    );
    // Every one of these would otherwise reach a date column or raise
    // `numeric field overflow` on insert.
    expect(result.purchasedAt).toBe("");
    expect(result.expiresAt).toBe("");
    expect(result.value).toBe("");
    expect(result.product).toBe("Toaster");
  });

  it("neutralizes fence markers a model echoed back and caps free text", () => {
    const result = buildWarrantyExtraction(
      JSON.stringify({
        product: `<<<DOCUMENT>>>${"x".repeat(300)}`,
        notes: "y".repeat(400),
      }),
    );
    expect(result.product.startsWith(FENCE_SENTINEL)).toBe(true);
    expect(result.product.length).toBeLessThanOrEqual(160);
    expect(result.notes.length).toBeLessThanOrEqual(300);
  });

  it("comes back empty rather than throwing on an unreadable answer", () => {
    expect(buildWarrantyExtraction("not json at all")).toEqual({
      merchant: "",
      product: "",
      value: "",
      purchasedAt: "",
      expiresAt: "",
      terms: "",
      confidence: "low",
      notes: "",
    });
  });
});

describe("extractWarrantyFields", () => {
  it("reads an image with the vision model and the document fence", async () => {
    const result = await extractWarrantyFields({
      accountId: TEST_ACCOUNT_ID,
      buffer: await tinyPng(),
      mime: "image/png",
    });

    expect(result.product).toBe("Espresso machine");
    expect(result.expiresAt).toBe("2028-07-15");
    expect(calls).toHaveLength(1);
    const body = calls[0]!;
    expect(body.model).toBe(LLM_VISION_MODEL);
    expect(body.response_format).toEqual({ type: "json_object" });
    // DeepSeek's thinking stays off: it burns the output budget on
    // reasoning before the answer.
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.messages[0]!.content).toContain("warranty details");
    // The image rides as a data URL beside the fenced text part.
    const content = body.messages[1]!.content as Array<{
      type: string;
      image_url?: { url: string };
    }>;
    expect(content[0]!.type).toBe("text");
    expect(content[1]!.image_url!.url.startsWith("data:image/")).toBe(true);
  });

  it("reads a dropped PDF with a text layer as text, not as an image", async () => {
    const { promise, resolve } = Promise.withResolvers<Buffer>();
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ size: "LETTER" });
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc
      .fontSize(12)
      .text("Warranty terms: covered for 24 months from the purchase date.");
    doc.end();
    const pdf = await promise;

    await extractWarrantyFields({
      accountId: TEST_ACCOUNT_ID,
      buffer: pdf,
      mime: "application/pdf",
    });

    // Text mode goes to the text model with no image attached: a PDF whose
    // text layer is readable must not pay for vision tokens.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe(LLM_MODEL);
    expect(typeof calls[0]!.messages[1]!.content).toBe("string");
  });

  it("reads the same document once: a re-drop hits the cache", async () => {
    const buffer = await tinyPng();
    const first = await extractWarrantyFields({
      accountId: TEST_ACCOUNT_ID,
      buffer,
      mime: "image/png",
    });
    const second = await extractWarrantyFields({
      accountId: TEST_ACCOUNT_ID,
      buffer,
      mime: "image/png",
    });
    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
    // The row is namespaced, so the same bytes cached for a receipt read
    // can't be handed back as a warranty.
    expect(warrantyExtractionCacheKey(buffer)).toMatch(/^warr:[0-9a-f]{64}$/);
  });
});

describe("productFromFileName", () => {
  it("falls back to the file's own name when the document names no product", () => {
    expect(productFromFileName("espresso-machine-manual.pdf")).toBe(
      "espresso machine manual",
    );
    expect(productFromFileName("IMG_2043.jpg")).toBe("IMG 2043");
    expect(productFromFileName("toaster")).toBe("toaster");
    expect(productFromFileName("")).toBe("");
  });
});
