import {
  extractionCacheKey,
  readCachedExtraction,
  writeCachedExtraction,
} from "~/lib/db/extraction-cache";
import { normalizeMerchant } from "~/lib/duplicates";
import { DEEPSEEK_API_KEY, DEEPSEEK_MODEL } from "~/lib/env";
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
  /** Scoped cache key — extraction results are per-account. */
  accountId: string;
  text?: string;
  image?: { buffer: Buffer; mime: string };
  /** Existing category names — the model picks the closest one or "". */
  categories?: string[];
  /** Existing report names — the model picks the closest one or "". */
  reports?: string[];
}

type Confidence = "high" | "medium" | "low";

/**
 * A merchant the account has spent with before (last 90 days): its display
 * name plus the category/report of its most recent expense for each field.
 * The map keys are normalized merchant names (same rule as duplicate
 * detection), the values carry the display spelling. Built once per
 * extraction by `readKnownMerchants`; the LLM-skip path matches receipt
 * text against these before any model call.
 */
export interface KnownMerchant {
  /** Display spelling from the most recent expense for this merchant. */
  display: string;
  /** Category of the merchant's most recent categorized expense, or "". */
  category: string;
  /** Report of the merchant's most recent reported expense, or "". */
  report: string;
}

/**
 * The first word-bounded occurrence of a known merchant name in the
 * receipt text, choosing the longest (most specific) match when several
 * known merchants appear. Returns null when none match. The text is
 * normalized the same way as merchant keys (lowercase, whitespace
 * collapsed) so line breaks and case inside a merchant name don't hide it.
 */
export function matchKnownMerchant(
  text: string,
  known: ReadonlyMap<string, KnownMerchant>,
): KnownMerchant | null {
  if (!text || known.size === 0) return null;
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  let best: { key: string; merchant: KnownMerchant } | null = null;
  for (const [key, merchant] of known) {
    if (!key) continue;
    let from = 0;
    for (;;) {
      const i = normalized.indexOf(key, from);
      if (i === -1) break;
      if (isWordBounded(normalized, i, i + key.length)) {
        if (!best || key.length > best.key.length) {
          best = { key, merchant };
        }
        break;
      }
      from = i + key.length;
    }
  }
  return best?.merchant ?? null;
}

/** Key must not be flanked by letters/digits — "amc" must not match
 * "camcorder" — but punctuation and whitespace are fine boundaries. */
function isWordBounded(text: string, start: number, end: number): boolean {
  const before = start === 0 ? "" : text[start - 1]!;
  const after = end >= text.length ? "" : text[end]!;
  return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
}

const CURRENCY_BY_SYMBOL: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
};

const CURRENCY_BY_CODE: Record<string, string> = {
  eur: "EUR",
  usd: "USD",
  gbp: "GBP",
  jpy: "JPY",
};

/** Lines that must not supply the fallback amount (printed after the total
 * on many receipts: tip suggestions, change due). */
const NON_AMOUNT_LINE = /\b(tip|gratuity|change)\b/i;
/** An amount line that names the total explicitly. */
const TOTAL_LINE =
  /\b(total|grand total|amount due|balance due|total due|amount paid|payment)\b/i;
/**
 * A two-decimal amount in either convention: "1,234.56" (US grouping,
 * dot decimal) or "1.234,56" / "12,50" (comma decimal, EU). The
 * leading lookbehind blocks partial-number matches ("0.00" inside
 * "-20.00"), the trailing lookahead blocks suffix matches inside
 * longer decimals ("1,234.56" can't match as "1,23"). Refunds
 * ("-20.00") never match and fall through to the LLM.
 */
const AMOUNT_NUM_RE =
  /(?<![0-9,.-])(\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|\d+[.,]\d{2})(?![0-9])/;
const AMOUNT_NUM_GLOBAL = new RegExp(AMOUNT_NUM_RE.source, "g");

/** Normalize a matched amount to "1234.56" (dot decimal, no grouping). */
function normalizeAmountMatch(match: string): string {
  const commaDecimal = match.lastIndexOf(",") > match.lastIndexOf(".");
  if (commaDecimal) return match.replace(/\./g, "").replace(/,/g, ".");
  return match.replace(/,/g, "");
}

/** The currency symbol or ISO code adjacent to the amount, or "". */
function currencyAround(line: string, start: number, len: number): string {
  const before = line.slice(0, start);
  const symBefore = before.match(/(\$|€|£|¥)\s*$/);
  if (symBefore) return symBefore[1]!;
  const codeBefore = before.match(/\b(eur|usd|gbp|jpy)\b\s*$/i);
  if (codeBefore) return codeBefore[1]!;
  const after = line.slice(start + len);
  const symAfter = after.match(/^\s*([€£¥$])/);
  if (symAfter) return symAfter[1]!;
  const codeAfter = after.match(/^\s*(eur|usd|gbp|jpy)\b/i);
  if (codeAfter) return codeAfter[1]!;
  return "";
}

function currencyValue(symOrCode: string): string {
  return (
    CURRENCY_BY_SYMBOL[symOrCode] ??
    CURRENCY_BY_CODE[symOrCode.toLowerCase()] ??
    "USD"
  );
}

/** Every (amount, currency) pair on a line, left to right. Currency is ""
 * when no symbol/code sits adjacent to the number. */
function amountsOnLine(line: string): Array<{
  num: string;
  start: number;
  currency: string;
}> {
  const amounts: Array<{ num: string; start: number; currency: string }> = [];
  for (const m of line.matchAll(AMOUNT_NUM_GLOBAL)) {
    const num = m[1]!;
    amounts.push({
      num,
      start: m.index!,
      currency: currencyAround(line, m.index!, num.length),
    });
  }
  return amounts;
}

/**
 * Deterministic total extraction for the LLM-skip path: prefer an explicit
 * "total"/"amount due" line (either decimal convention, symbol or code
 * before or after), else the last currency-marked amount not on a
 * tip/change line. Returns null when nothing is trustworthy — the caller
 * then falls through to the LLM. Refund/credit receipts (negative
 * amounts) never match and are left to the model.
 */
export function parseReceiptAmount(text: string): {
  amount: string;
  currency: string;
} | null {
  if (!text) return null;
  const lines = text.split("\n");
  // Pass 1: an explicit total/amount line — take the amount closest to the
  // keyword so "Subtotal: $38.00 — TOTAL: $42.50" picks the total.
  for (const line of lines) {
    if (!TOTAL_LINE.test(line)) continue;
    const keywordIndex = line.match(TOTAL_LINE)?.index ?? 0;
    let best: { num: string; dist: number; currency: string } | null = null;
    for (const a of amountsOnLine(line)) {
      const dist = Math.abs(a.start - keywordIndex);
      if (!best || dist <= best.dist) {
        best = { num: a.num, dist, currency: a.currency };
      }
    }
    if (best) {
      return {
        amount: normalizeAmount(normalizeAmountMatch(best.num)),
        currency: currencyValue(best.currency),
      };
    }
  }
  // Pass 2: last amount with a currency marker, skipping tip/change lines.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (NON_AMOUNT_LINE.test(line)) continue;
    const marked = amountsOnLine(line).find((a) => a.currency);
    if (marked) {
      return {
        amount: normalizeAmount(normalizeAmountMatch(marked.num)),
        currency: currencyValue(marked.currency),
      };
    }
  }
  return null;
}

/**
 * Full extraction without any model call: the receipt text names a known
 * merchant and a total amount, so merchant/category/report come from the
 * account's own history and the amount is parsed deterministically. Returns
 * null when either is missing or ambiguous — callers then run the LLM.
 */
export function tryKnownMerchantExtraction(
  text: string,
  known: ReadonlyMap<string, KnownMerchant>,
): ExtractionResult | null {
  const merchant = matchKnownMerchant(text, known);
  if (!merchant) return null;
  const amount = parseReceiptAmount(text);
  if (!amount) return null;
  console.info("[extraction] known-merchant skip:", merchant.display);
  return {
    isReceipt: true,
    merchant: merchant.display,
    description: "",
    amount: amount.amount,
    currency: amount.currency,
    category: merchant.category,
    report: merchant.report,
    confidence: "high",
    notes: "",
  };
}

/** Curated display names for the general-rule senders — the merchants a
 * fresh mailbox is most likely to see first, before any expense history
 * exists. Falls back to a title-cased leftmost domain label for anything
 * else (learned/inferred rules on senders without a curated name). */
const MERCHANT_BY_SENDER: Record<string, string> = {
  "apple.com": "Apple",
  "amazon.com": "Amazon",
  "stripe.com": "Stripe",
  "paypal.com": "PayPal",
  "uber.com": "Uber",
  "lyft.com": "Lyft",
  "doordash.com": "DoorDash",
  "grubhub.com": "Grubhub",
  "instacart.com": "Instacart",
  "squareup.com": "Square",
};

/** A display merchant name for a rule sender domain. Curated for the seeded
 * general rules; otherwise title-cases the leftmost label
 * ("acme-shop.example" -> "Acme-shop"). */
function merchantForSender(sender: string): string {
  const key = sender.trim().toLowerCase();
  if (MERCHANT_BY_SENDER[key]) return MERCHANT_BY_SENDER[key]!;
  const label = key.split(".")[0] || key;
  if (!label) return sender;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Local extraction for a FIRST-TIME merchant matched by a general rule:
 * the merchant name comes from the rule sender domain (no prior expense
 * history needed), the total from parseReceiptAmount. Category is "" — the
 * completeness badge prompts the user to set it once, after which the
 * known-merchant path carries it forward. Returns null when no total can
 * be parsed locally (refunds, no explicit total, unusual layout) — callers
 * then skip the email (never fall through to the model in the connected
 * flow). Confidence is "medium": the merchant is inferred from the sender,
 * not read off the receipt. */
export function tryRuleMerchantExtraction(
  text: string,
  sender: string,
): ExtractionResult | null {
  const amount = parseReceiptAmount(text);
  if (!amount) return null;
  const merchant = merchantForSender(sender);
  console.info("[extraction] rule-merchant skip:", merchant);
  return {
    isReceipt: true,
    merchant,
    description: "",
    amount: amount.amount,
    currency: amount.currency,
    category: "",
    report: "",
    confidence: "medium",
    notes: "",
  };
}

export interface ExtractionResult {
  isReceipt: boolean;
  merchant: string;
  description: string;
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
- "description": a short description of the purchase (e.g. "Team lunch", "Printer paper"), or "" if unknown
- "amount": the total amount paid as a plain decimal string like "42.50" — no currency symbols, no commas, no text; "" if unknown
- "currency": ISO 4217 currency code (e.g. "USD", "EUR"); "USD" if unclear
- "category": a suggested category — only set this if you are at least 80% confident it is correct; otherwise ""
- "report": a suggested report name — only set this if you are at least 95% confident it is correct; otherwise ""
- "confidence": "high", "medium", or "low"
- "notes": one short sentence about anything ambiguous or missing
Only output valid JSON. If the content is not a receipt, set "is_receipt" to false and leave the other fields empty.`;

/**
 * Cap the receipt text sent to the model. A receipt's key fields sit at the
 * extremes — merchant/date at the top, tax/total at the bottom — so keep
 * both ends and drop the middle line items. Only binds on pathological
 * input (noisy OCR, very long PDFs/email bodies); a normal receipt passes
 * through untouched.
 */
const MAX_RECEIPT_TEXT_CHARS = 6_000;
const MAX_RECEIPT_HEAD_CHARS = 4_000;

function limitReceiptText(text: string): string {
  if (text.length <= MAX_RECEIPT_TEXT_CHARS) return text;
  const head = text.slice(0, MAX_RECEIPT_HEAD_CHARS);
  const tail = text.slice(
    text.length - (MAX_RECEIPT_TEXT_CHARS - MAX_RECEIPT_HEAD_CHARS),
  );
  return `${head}\n\n… (middle truncated) …\n\n${tail}`;
}

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
  lines.push("Receipt content:", limitReceiptText(input.text ?? ""));
  return lines.join("\n\n");
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

async function chatCompletion(
  messages: ChatMessage[],
  opts: {
    json?: boolean;
    image?: { buffer: Buffer; mime: string };
    /** Output token cap — per call site, sized to that call's real answer. */
    maxTokens?: number;
  } = {},
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
    max_tokens: opts.maxTokens ?? 500,
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

/** Extract structured receipt data from text and/or an image. The LLM call
 * is skipped when (a) the input matches a freshly cached extraction for
 * this account, or (b) — for text inputs — the text names a known merchant
 * with a parseable total (see tryKnownMerchantExtraction). */
export async function extractReceipt(
  input: ExtractionInput,
): Promise<ExtractionResult> {
  const cacheKey = extractionCacheKey(input);
  if (cacheKey) {
    const cached = await readCachedExtraction(input.accountId, cacheKey);
    if (cached) {
      console.info("[extraction] cache hit:", cached.merchant || "(unknown)");
      return cached;
    }
  }
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(input) },
  ];
  const raw = await chatCompletion(messages, {
    json: true,
    maxTokens: 400,
    ...(input.image ? { image: input.image } : {}),
  });
  const result = buildExtractionResult(raw);
  if (cacheKey) {
    await writeCachedExtraction(input.accountId, cacheKey, result).catch(
      () => {},
    );
  }
  return result;
}

function buildExtractionResult(raw: string): ExtractionResult {
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
    description: stringField(parsed, "description").trim(),
    amount,
    currency,
    category: stringField(parsed, "category").trim(),
    report: stringField(parsed, "report").trim(),
    confidence: confidenceField(parsed["confidence"]),
    notes: stringField(parsed, "notes").trim(),
  };
}

/** Best-matching existing name, or "" when nothing matches. Exact match
 * wins; otherwise a containment match either direction. Shared by the
 * category and report lookups, which differ only in the label. */
function matchName(suggested: string, existing: string[]): string {
  const s = suggested.trim().toLowerCase();
  if (!s) return "";
  const exact = existing.find((name) => name.toLowerCase() === s);
  if (exact) return exact;
  const fuzzy = existing.find(
    (name) => name.toLowerCase().includes(s) || s.includes(name.toLowerCase()),
  );
  return fuzzy ?? "";
}

/** Best-matching existing category name, or "" when nothing matches. */
export function matchCategory(suggested: string, existing: string[]): string {
  return matchName(suggested, existing);
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
  knownMerchants: ReadonlyMap<string, KnownMerchant>,
  existing: string[],
): string {
  return resolvePriorField(
    merchant,
    suggested,
    knownMerchants,
    existing,
    (m) => m.category,
    matchCategory,
  );
}

/**
 * Pick the report for a new receipt. A previous expense for the same
 * merchant (normalized name match, last 90 days) wins — the merchant was
 * already filed to a report. Without a prior report, the model's suggestion
 * is mapped onto an existing report name ("" when nothing fits).
 */
function resolveReport(
  merchant: string,
  suggested: string,
  knownMerchants: ReadonlyMap<string, KnownMerchant>,
  existing: string[],
): string {
  return resolvePriorField(
    merchant,
    suggested,
    knownMerchants,
    existing,
    (m) => m.report,
    matchName,
  );
}

/** Shared by resolveCategory/resolveReport: the merchant's stored value for
 * the field wins over the model's suggestion; otherwise the suggestion is
 * mapped onto an existing name. */
function resolvePriorField(
  merchant: string,
  suggested: string,
  knownMerchants: ReadonlyMap<string, KnownMerchant>,
  existing: string[],
  field: (m: KnownMerchant) => string,
  match: (suggested: string, existing: string[]) => string,
): string {
  if (merchant.trim()) {
    const prior = knownMerchants.get(normalizeMerchant(merchant));
    if (prior) {
      const value = field(prior);
      if (value) return value;
    }
  }
  return match(suggested, existing);
}

/** The extraction context resolved by `readExtractionContext` (database.ts):
 * the account's category/report names plus the known-merchant map (which
 * also supplies the prior category/report lookups and drives the LLM-skip
 * path). */
export interface ExtractionContext {
  categories: string[];
  reports: string[];
  knownMerchants: ReadonlyMap<string, KnownMerchant>;
}

/**
 * Resolve a receipt's category + report from its extracted merchant and the
 * model's suggestions against the account's extraction context. The
 * merchant's prior category/report (normalized name match) wins; otherwise
 * the suggestion is mapped onto an existing name ("" when nothing fits).
 * Shared by the draft-image and inbound-email pipelines so the two can't
 * drift apart.
 */
export function resolveExtraction(
  context: ExtractionContext,
  input: { merchant: string; category: string; report: string },
): { category: string; report: string } {
  return {
    category: resolveCategory(
      input.merchant,
      input.category,
      context.knownMerchants,
      context.categories,
    ),
    report: resolveReport(
      input.merchant,
      input.report,
      context.knownMerchants,
      context.reports,
    ),
  };
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
  const raw = await chatCompletion(messages, { json: true, maxTokens: 80 });
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
