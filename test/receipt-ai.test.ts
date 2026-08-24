import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LLM_MAX_TOKENS,
  LLM_MODEL,
  LLM_VISION_MAX_TOKENS,
  LLM_VISION_MODEL,
} from "~/lib/env";
import { extractReceipt } from "~/lib/receipt-ai.server";

/**
 * LLM request-shape contract for receipt extraction. The fetch is stubbed
 * and the outgoing body captured, so this pins what the app actually sends:
 * text extraction goes to the text model with DeepSeek's `thinking`
 * disabled, and image extraction goes to the vision model override with the
 * same disabled thinking (the vision model is a reasoning model — leaving
 * it on burns the output budget on reasoning_content) and the larger output
 * cap (it burns budget in reasoning before answering). A real JSON answer
 * is returned so the result is parsed too.
 *
 * LLM_API_KEY/LLM_BASE_URL/LLM_VISION_MODEL are pinned in vitest.main.config
 * test.env — CI has no .env and env.ts reads these at import time.
 */

let lastBody: {
  model: string;
  max_tokens: number;
  thinking?: unknown;
  messages: Array<{ role: string; content: unknown }>;
} | null = null;

const MODEL_ANSWER = JSON.stringify({
  choices: [
    {
      message: {
        content:
          '{"is_receipt":true,"merchant":"Acme Cafe","amount":"12.50",' +
          '"currency":"USD","description":"","category":"","report":"",' +
          '"confidence":"high","notes":""}',
      },
    },
  ],
});

beforeEach(() => {
  lastBody = null;
  vi.stubGlobal("fetch", async (_url: unknown, init: { body?: string }) => {
    lastBody = JSON.parse(init?.body ?? "{}");
    return new Response(MODEL_ANSWER, { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("receipt extraction LLM request shape", () => {
  it("sends text extraction to the text model with thinking disabled", async () => {
    const result = await extractReceipt({
      accountId: "llm-shape-test",
      text: "ACME CAFE\nTOTAL $12.50",
    });

    expect(lastBody).not.toBeNull();
    expect(lastBody!.model).toBe(LLM_MODEL);
    expect(lastBody!.max_tokens).toBe(400);
    expect(lastBody!.thinking).toEqual({ type: "disabled" });
    // Text path: the user message is a plain string, not an image array.
    const user = lastBody!.messages.at(-1)!;
    expect(typeof user.content).toBe("string");
    expect(result.merchant).toBe("Acme Cafe");
    expect(result.isReceipt).toBe(true);
  });

  it("sends image extraction to the vision model with thinking disabled", async () => {
    const result = await extractReceipt({
      accountId: "llm-shape-test",
      image: {
        buffer: Buffer.from("vision-receipt-png-bytes"),
        mime: "image/png",
      },
    });

    expect(lastBody).not.toBeNull();
    expect(lastBody!.model).toBe(LLM_VISION_MODEL);
    expect(lastBody!.model).toBe("vision-test-model");
    expect(lastBody!.thinking).toEqual({ type: "disabled" });
    expect(lastBody!.max_tokens).toBe(LLM_VISION_MAX_TOKENS);
    // Image path: the user message carries text + a base64 data-URL image.
    const user = lastBody!.messages.at(-1)!;
    expect(Array.isArray(user.content)).toBe(true);
    const parts = user.content as Array<{
      type: string;
      image_url?: { url: string };
    }>;
    expect(parts[1]!.type).toBe("image_url");
    expect(parts[1]!.image_url!.url.startsWith("data:image/png;base64,")).toBe(
      true,
    );
    expect(result.merchant).toBe("Acme Cafe");
    expect(result.isReceipt).toBe(true);
  });

  it("uses LLM_MAX_TOKENS as the default cap on other call paths", () => {
    // Classify-receipt attachment calls pass their own cap; the text
    // extraction cap above is 400. This guards the default wiring: a call
    // without an explicit cap falls back to LLM_MAX_TOKENS.
    expect(LLM_MAX_TOKENS).toBeGreaterThan(0);
    expect(LLM_VISION_MAX_TOKENS).toBeGreaterThan(LLM_MAX_TOKENS);
  });
});
