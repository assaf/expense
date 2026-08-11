import { DEEPSEEK_API_KEY, DEEPSEEK_MODEL } from "~/lib/env";
import { normalizeMerchant } from "~/lib/duplicates";
import { normalizeAmount } from "~/lib/format";

/**
 * Receipt data extraction via the DeepSeek API (OpenAI-compatible chat
 * completions, base URL https://api.deepseek.com, model deepseek-v4-flash).
 *
 * Two modes:
 *  - text input: receipt text extracted from the email body / PDF text layer /
 *    OCR output → structured JSON
 *  - image input: the receipt image is sent as a data URL so a vision-capable
 *    model can OCR + extract in one step. The hosted API may reject images
 *    (see isVisionUnsupportedError); callers fall back to tesseract OCR.
 *
 * JSON mode (`response_format: { type: "json_object" }`) is used and thinking
 * mode is disabled so extraction stays fast and cheap.
 */

interface ExtractionInput {
  text?: string;
  image?: { buffer: Buffer; mime: string };
  /** Existing category names — the model picks the closest one or "". */
  categories?: string[];
  /** Existing report names — the model picks the closest one or "". */
  reports?: string[];
}

type Confidence = "high" | "medium" | "low";

export interface ExtractionResult {
  isReceipt: boolean;
  merchant: string;
  amount: string; // decimal string "42.50", "" when unknown
  currency: string; // ISO 4217
  category: string;
  report: string;
  confidence: Confidence;
  notes: string;
}

class DeepSeekError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

const SYSTEM_PROMPT = `You extract receipt data for a personal expense tracker. Given receipt text or a receipt image, return JSON with exactly these fields:
- "is_receipt": true when the content is a receipt, invoice, order confirmation, or payment confirmation that shows a total amount; otherwise false
- "merchant": the merchant or vendor name (the business the money was paid to), or "" if unknown
- "amount": the total amount paid as a plain decimal string like "42.50" — no currency symbols, no commas, no text; "" if unknown
- "currency": ISO 4217 currency code (e.g. "USD", "EUR"); "USD" if unclear
- "category": a suggested category — only set this if you are at least 80% confident it is correct; otherwise ""
- "report": a suggested report name — only set this if you are at least 95% confident it is correct; otherwise ""
- "confidence": "high", "medium", or "low"
- "notes": one short sentence about anything ambiguous or missing
Only output valid JSON. If the content is not a receipt, set "is_receipt" to false and leave the other fields empty.`;

function buildUserPrompt(input: ExtractionInput): string {
  const lines: string[] = [];
  if (input.categories && input.categories.length > 0) {
    lines.push(
      `Existing categories — pick the closest match for "category" or use "": ${input.categories.join(", ")}`,
    );
  }
  if (input.reports && input.reports.length > 0) {
    lines.push(
      `Existing reports — pick the closest match for "report" or use "": ${input.reports.join(", ")}`,
    );
  }
  lines.push("Receipt content:", (input.text ?? "").slice(0, 30_000));
  return lines.join("\n\n");
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

async function chatCompletion(
  messages: ChatMessage[],
  opts: { json?: boolean; image?: { buffer: Buffer; mime: string } } = {},
): Promise<string> {
  if (!DEEPSEEK_API_KEY) {
    throw new DeepSeekError("DEEPSEEK_API_KEY is not configured", 500, "");
  }
  const last = messages[messages.length - 1]!;
  let content: unknown = last.content;
  if (opts.image) {
    content = [
      { type: "text", text: last.content },
      {
        type: "image_url",
        image_url: {
          url: `data:${opts.image.mime};base64,${opts.image.buffer.toString("base64")}`,
        },
      },
    ];
  }
  const body = {
    model: DEEPSEEK_MODEL,
    messages: [...messages.slice(0, -1), { role: "user", content }],
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    thinking: { type: "disabled" },
    temperature: 0.1,
    max_tokens: 1500,
  };
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new DeepSeekError(
      `DeepSeek API ${res.status}: ${text.slice(0, 500)}`,
      res.status,
      text,
    );
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const contentStr = data.choices?.[0]?.message?.content ?? "";
  if (!contentStr)
    throw new DeepSeekError("DeepSeek returned empty content", 502, "");
  return contentStr;
}

/** Robustly extract a JSON object from a model response (fences, prose). */
export function parseJsonObject(raw: string): Record<string, unknown> {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1]!.trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    throw new DeepSeekError(
      "DeepSeek returned invalid JSON",
      502,
      raw.slice(0, 500),
    );
  }
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

function confidenceField(v: unknown): Confidence {
  // Exact or case-insensitive match on high/medium/low; anything else → low.
  if (typeof v === "string") {
    const lower = v.toLowerCase();
    if (lower === "high" || lower === "medium" || lower === "low") {
      return lower;
    }
  }
  return "low";
}

/** Extract structured receipt data from text and/or an image. */
export async function extractReceipt(
  input: ExtractionInput,
): Promise<ExtractionResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(input) },
  ];
  const raw = await chatCompletion(messages, {
    json: true,
    ...(input.image ? { image: input.image } : {}),
  });
  const parsed = parseJsonObject(raw);
  const isReceiptRaw = parsed["is_receipt"];
  const isReceipt =
    isReceiptRaw !== false &&
    isReceiptRaw !== "false" &&
    isReceiptRaw !== 0 &&
    isReceiptRaw !== "no";
  const merchant = stringField(parsed, "merchant").trim();
  const amount = normalizeAmount(
    stringField(parsed, "amount").replace(/[^0-9.-]/g, ""),
  );
  const currency = (
    stringField(parsed, "currency").toUpperCase() || "USD"
  ).slice(0, 3);
  return {
    isReceipt,
    merchant,
    amount,
    currency,
    category: stringField(parsed, "category").trim(),
    report: stringField(parsed, "report").trim(),
    confidence: confidenceField(parsed["confidence"]),
    notes: stringField(parsed, "notes").trim(),
  };
}

/** Best-matching existing category name, or "" when nothing matches. */
export function matchCategory(suggested: string, existing: string[]): string {
  const s = suggested.trim().toLowerCase();
  if (!s) return "";
  const exact = existing.find((c) => c.toLowerCase() === s);
  if (exact) return exact;
  const fuzzy = existing.find(
    (c) => c.toLowerCase().includes(s) || s.includes(c.toLowerCase()),
  );
  return fuzzy ?? "";
}

/** Best-matching existing report name, or "" when nothing matches. */
/** @public */
export function matchReport(suggested: string, existing: string[]): string {
  const s = suggested.trim().toLowerCase();
  if (!s) return "";
  const exact = existing.find((r) => r.toLowerCase() === s);
  if (exact) return exact;
  const fuzzy = existing.find(
    (r) => r.toLowerCase().includes(s) || s.includes(r.toLowerCase()),
  );
  return fuzzy ?? "";
}

/**
 * Pick the category for a new receipt. A previous expense for the same
 * merchant (normalized name match, same rule as duplicate detection) wins —
 * the merchant was already categorized, so its category is reused instead of
 * guessed. Without a prior category, the model's suggestion is mapped onto
 * an existing category name ("" when nothing fits).
 */
export function resolveCategory(
  merchant: string,
  suggested: string,
  merchantCategories: ReadonlyMap<string, string>,
  existing: string[],
): string {
  if (merchant.trim()) {
    const prior = merchantCategories.get(normalizeMerchant(merchant));
    if (prior) return prior;
  }
  return matchCategory(suggested, existing);
}

/**
 * Pick the report for a new receipt. A previous expense for the same
 * merchant (normalized name match, last 90 days) wins — the merchant was
 * already filed to a report. Without a prior report, the model's suggestion
 * is mapped onto an existing report name ("" when nothing fits).
 */
export function resolveReport(
  merchant: string,
  suggested: string,
  merchantReports: ReadonlyMap<string, string>,
  existing: string[],
): string {
  if (merchant.trim()) {
    const prior = merchantReports.get(normalizeMerchant(merchant));
    if (prior) return prior;
  }
  return matchReport(suggested, existing);
}

/** True when the hosted API rejected the request because it can't read images. */
export function isVisionUnsupportedError(err: unknown): boolean {
  if (!(err instanceof DeepSeekError)) return false;
  if (err.status !== 400 && err.status !== 422) return false;
  return /image|vision|content.?type|unsupported|not supported|multimodal/i.test(
    err.message,
  );
}

export interface AttachmentCandidate {
  /** Index into the original attachments array. */
  index: number;
  filename: string;
  contentType: string;
  size: number | null;
  inline: boolean;
  referenced: boolean;
}

/**
 * Ask the model which attachment is the actual receipt (used only when the
 * heuristic scoring is ambiguous). Returns the original attachment index, or
 * null when none of them look like a receipt.
 */
export async function classifyReceiptAttachment(
  candidates: AttachmentCandidate[],
): Promise<number | null> {
  const list = candidates
    .map(
      (c) =>
        `${c.index}: "${c.filename}" (${c.contentType}, ${c.size ?? "?"} bytes, ${c.inline ? "inline" : "attachment"}, ${c.referenced ? "referenced-in-email" : "not-referenced"})`,
    )
    .join("\n");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        'You choose which email attachment is the receipt. Return JSON: { "receipt_index": <number|null>, "reason": "short reason" }. Ignore logos, signatures, banners, icons, and other decoration. The receipt is usually a PDF or an image showing a purchase, invoice, or order with amounts.',
    },
    {
      role: "user",
      content: `Attachments:\n${list}\n\nWhich one is the receipt?`,
    },
  ];
  const raw = await chatCompletion(messages, { json: true });
  const parsed = parseJsonObject(raw);
  const idx = parsed["receipt_index"];
  const n =
    typeof idx === "number"
      ? idx
      : typeof idx === "string"
        ? Number.parseInt(idx, 10)
        : Number.NaN;
  if (!Number.isInteger(n) || n < 0 || n >= candidates.length) return null;
  return candidates[n]!.index;
}
