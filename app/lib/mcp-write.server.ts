import { hasEnoughStops } from "~/lib/completeness";
import { findSameImageExpense, upsertExpense } from "~/lib/db/expenses";
import { readExtractionContext } from "~/lib/db/extraction-context";
import { readMileageRates } from "~/lib/db/seed";
import { captureWarning } from "~/lib/errors.server";
import { normalizeAmount } from "~/lib/format";
import { validateExpenseInputs } from "~/lib/expense-save.server";
import {
  MAX_UPLOAD_BYTES,
  deleteImage,
  mimeForFile,
  renameImageToConvention,
  saveImage,
  uploadErrorMessage,
} from "~/lib/images.server";
import { recomputeMileage } from "~/lib/maps.server";
import { mileageRateFor } from "~/lib/mileage-rates";
import { convertToUsd } from "~/lib/fx.server";
import { fxProvenance, withConversionNote } from "~/lib/fx-note";
import { resolveCategory } from "~/lib/receipt-ai.server";
import { extractFromImage } from "~/lib/receipt-ocr.server";
import { fetchPublicUrl, readBodyLimited, SsrfError } from "~/lib/ssrf.server";
import {
  newExpenseShell,
  type Location,
  type MileageExpense,
  type MileageType,
  type ReceiptExpense,
} from "~/lib/types";

/**
 * The MCP write tools' implementations: capture_receipt's extraction
 * pipeline and log_mileage's geocode/route/price flow, plus the tool
 * result envelope every MCP tool handler returns. The handlers and their
 * input schemas live in mcp.server.ts and are thin adapters over these
 * functions — the same split as the read tools (mcp.server.ts over
 * expense-read.server.ts). Tool design principle (mcp.server.ts): expose
 * capabilities, not CRUD.
 */

// --- Tool results ----------------------------------------------------------

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** Success payload, JSON-encoded so agents get structured data. */
export function ok(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/** Error payload with isError set so clients surface it to the agent. */
export function fail(message: string): ToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify({ error: message }, null, 2) },
    ],
    isError: true,
  };
}

/** Shared prelude of the two write tools: resolve the expense date
 * (omitted means UTC today) and the trimmed report, then validate both.
 * Returns the fail payload instead of values when validation rejects the
 * input. serverUtcNow comes back so the client can resolve the user's local
 * date (the client knows its timezone; the server runs UTC). */
async function validatedExpenseInput(
  accountId: string,
  args: { date?: string; report?: string },
): Promise<
  | { ok: true; date: string; report: string; serverUtcNow: string }
  | { ok: false; result: ToolResult }
> {
  const serverUtcNow = new Date().toISOString();
  const date = args.date ?? serverUtcNow.slice(0, 10);
  const report = args.report?.trim() ?? "";
  const inputError = await validateExpenseInputs(accountId, date, report);
  if (inputError) return { ok: false, result: fail(inputError) };
  return { ok: true, date, report, serverUtcNow };
}

/**
 * Capture a receipt: decode the input, run the app's extraction pipeline
 * (DeepSeek vision/OCR, falling back to tesseract; category resolved from
 * the merchant's own history), persist the image, and create the expense.
 * Extraction failure never blocks the capture; the image is still stored
 * and the expense created with the fields we have (mirrors the draft flow).
 */
export async function captureReceipt(
  accountId: string,
  args: {
    imageData?: string;
    mime?: string;
    filename?: string;
    url?: string;
    merchant?: string;
    amount?: string;
    currency?: string;
    category?: string;
    date?: string;
    report?: string;
    description?: string;
  },
): Promise<ToolResult> {
  let buffer: Buffer;
  let mime: string;
  let originalName: string;

  if (args.imageData) {
    buffer = Buffer.from(args.imageData, "base64");
    mime = args.mime?.trim() || mimeForFile(args.filename ?? "") || "image/png";
    originalName = args.filename?.trim() || "receipt.png";
  } else if (args.url) {
    let res: Response;
    try {
      // SSRF-guarded: http(s) only, private/resolved-private hosts are
      // rejected, redirects are re-checked at every hop (ssrf.server).
      res = await fetchPublicUrl(args.url, { timeoutMs: 20_000 });
    } catch (err) {
      const reason =
        err instanceof SsrfError ? err.message : "network error or timeout";
      return fail(`Couldn't fetch ${args.url}: ${reason}.`);
    }
    if (!res.ok) return fail(`Couldn't fetch ${args.url}: HTTP ${res.status}.`);
    // Stream with a hard cap: the 15MB check must bound the download, not
    // run after the whole body has already been buffered (a big response
    // would OOM the function before the guard trips).
    let data: Buffer;
    try {
      data = await readBodyLimited(res, MAX_UPLOAD_BYTES);
    } catch (err) {
      const reason = err instanceof SsrfError ? err.message : "download failed";
      return fail(`Couldn't fetch ${args.url}: ${reason}.`);
    }
    buffer = data;
    const fromUrl = args.filename?.trim() || urlFilename(args.url) || "receipt";
    mime =
      args.mime?.trim() ||
      res.headers.get("content-type")?.split(";")[0]?.trim() ||
      mimeForFile(fromUrl) ||
      "image/png";
    originalName = fromUrl;
  } else {
    return fail("Provide either imageData (base64) or url.");
  }

  if (buffer.length === 0) return fail("Empty image data.");
  if (buffer.length > MAX_UPLOAD_BYTES) {
    return fail(uploadErrorMessage("too-large"));
  }

  // Extraction: best-effort. The capture still succeeds without it.
  const { categories, knownMerchants } = await readExtractionContext(accountId);
  let extracted: {
    isReceipt: boolean;
    merchant: string;
    amount: string;
    currency: string;
    category: string;
    confidence: string;
    notes: string;
  } | null = null;
  try {
    const { result, stored } = await extractFromImage({
      accountId,
      buffer,
      mime,
      categories,
      knownMerchants,
    });
    extracted = {
      isReceipt: result.isReceipt,
      merchant: result.merchant,
      amount: result.amount,
      currency: result.currency,
      category: result.category,
      confidence: result.confidence,
      notes: result.notes,
    };
    buffer = stored.buffer;
    mime = stored.mime;
  } catch (err) {
    captureWarning("[mcp] capture_receipt extraction failed", { error: err });
  }

  const merchant = args.merchant?.trim() || extracted?.merchant || "";
  const category = resolveCategory(
    merchant,
    args.category ?? extracted?.category ?? "",
    knownMerchants,
    categories,
  );
  const input = await validatedExpenseInput(accountId, args);
  if (!input.ok) return input.result;
  const { date, report, serverUtcNow } = input;
  // The receipt currency: explicit arg wins, else what the receipt reads,
  // else USD. A non-USD amount converts at the ECB rate for the expense
  // date (the IRS payment-date rule); no rate keeps the amount as-is.
  const receiptCurrency = (
    args.currency?.trim() ||
    extracted?.currency ||
    "USD"
  ).toUpperCase();
  const originalAmount = normalizeAmount(
    args.amount ?? extracted?.amount ?? "",
  );
  const conversion = await convertToUsd(originalAmount, receiptCurrency, date);
  const amount = conversion ? conversion.amount : originalAmount;

  const saved = await saveImage(accountId, buffer, mime, originalName);
  // The same image bytes are already an expense: drop the just-stored
  // copy and report the duplicate instead of importing it twice.
  const duplicateOf = saved.sha256
    ? await findSameImageExpense(accountId, saved.sha256)
    : undefined;
  if (duplicateOf) {
    await deleteImage(accountId, saved.filename);
    return ok({
      captured: false,
      duplicate: true,
      duplicateOf: duplicateOf.id,
      serverUtcNow,
    });
  }
  const fx = fxProvenance(receiptCurrency, originalAmount, conversion);
  const expense: ReceiptExpense = {
    ...(newExpenseShell("receipt") as ReceiptExpense),
    date,
    report,
    category,
    description: withConversionNote(args.description ?? "", fx),
    amount,
    merchant,
    imageFile: saved.filename,
    imageMime: saved.mime,
    originalName,
    imageSha256: saved.sha256,
    currency: fx.currency,
    originalAmount: fx.originalAmount,
    fxRate: fx.fxRate,
  };
  if (date && report && originalName) {
    expense.imageFile = await renameImageToConvention(
      accountId,
      expense.imageFile,
      date,
      report,
      originalName,
      saved.mime,
    );
  }
  await upsertExpense(expense, accountId);

  const warning =
    extracted === null
      ? "Receipt stored, but extraction failed — merchant/amount/category were not filled in."
      : !extracted.isReceipt
        ? "The content may not be a receipt — captured anyway with the fields found."
        : receiptCurrency !== "USD" && !conversion
          ? `Amount is in ${receiptCurrency} — no exchange rate was available, stored as-is (treated as USD).`
          : null;
  return ok({
    captured: true,
    expenseId: expense.id,
    extracted,
    resolved: { merchant, amount, category, date, report },
    serverUtcNow,
    ...(conversion ? { fx: conversion } : {}),
    ...(warning ? { warning } : {}),
  });
}

/** Geocode + route a trip and create the mileage expense. */
export async function logMileage(
  accountId: string,
  args: {
    locations: (string | { address: string; lat?: number; lng?: number })[];
    date?: string;
    type?: MileageType;
    report?: string;
    category?: string;
    description?: string;
  },
): Promise<ToolResult> {
  const input = await validatedExpenseInput(accountId, args);
  if (!input.ok) return input.result;
  const { date, report } = input;

  const stops: Location[] = args.locations.map((l) =>
    typeof l === "string"
      ? { address: l, lat: null, lng: null }
      : { address: l.address, lat: l.lat ?? null, lng: l.lng ?? null },
  );
  if (!hasEnoughStops(stops)) {
    return fail("A trip needs at least two stops.");
  }

  // The IRS rate for the trip's (date, type). No rate in the master table
  // for the period means no amount (never $0.00).
  const rate = mileageRateFor(
    await readMileageRates(),
    date,
    args.type ?? "business",
  );
  const {
    locations,
    distanceMiles,
    amount,
    approximate,
    coords,
    returnCoords,
  } = await recomputeMileage(stops, rate);

  const expense: MileageExpense = {
    ...(newExpenseShell("mileage") as MileageExpense),
    date,
    report,
    category: args.category?.trim() ?? "",
    description: args.description ?? "",
    mileageType: args.type ?? "business",
    amount,
    locations,
    distanceMiles,
    route: { coords, returnCoords },
  };
  await upsertExpense(expense, accountId);

  return ok({
    logged: true,
    expenseId: expense.id,
    stops: locations.map((l) => l.address),
    distanceMiles,
    amount,
    type: expense.mileageType,
    rate: rate || null,
    approximate,
    ...(approximate
      ? {
          note: "Route service unavailable — distance is straight-line; re-save the expense later to recompute.",
        }
      : {}),
  });
}

function urlFilename(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    return last ?? "";
  } catch {
    return "";
  }
}
