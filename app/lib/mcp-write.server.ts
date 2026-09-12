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
 *
 * It also hosts the read/write halves the insights chat shares:
 * `resolveMileage` and `resolveExpense` validate and resolve without
 * writing anything (the model's side of a plan tool), and the `save`
 * functions file a proposal the user confirmed.
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
 * Returns the error message instead of values when validation rejects the
 * input. serverUtcNow comes back so the client can resolve the user's local
 * date (the client knows its timezone; the server runs UTC). */
async function validatedExpenseInput(
  accountId: string,
  args: { date?: string; report?: string },
): Promise<
  | { ok: true; date: string; report: string; serverUtcNow: string }
  | { ok: false; error: string }
> {
  const serverUtcNow = new Date().toISOString();
  const date = args.date ?? serverUtcNow.slice(0, 10);
  const report = args.report?.trim() ?? "";
  const inputError = await validateExpenseInputs(accountId, date, report);
  if (inputError) return { ok: false, error: inputError };
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
  if (!input.ok) return fail(input.error);
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

/** A trip resolved to a priced route, before anything is written: what
 * log_mileage files, and what the insights chat shows the user to confirm. */
export interface ResolvedTrip {
  date: string;
  report: string;
  type: MileageType;
  locations: Location[];
  distanceMiles: string;
  amount: string;
  /** The IRS rate used, "" when no published rate covers (date, type). */
  rate: string;
  /** True when the routing service was unavailable and the distance is
   * straight-line (the coordinates are still real addresses). */
  approximate: boolean;
  /** The trip's shape: true returns to the first stop (a closed loop),
   * false ends at the last stop. */
  roundTrip: boolean;
  coords: [number, number][];
  returnCoords: [number, number][];
}

/** Validate the inputs, geocode the stops, route the trip and price it.
 * Writes nothing: this is the read half of log_mileage, shared with the
 * insights chat, which proposes the trip and only files it on the user's
 * confirmation. `error` carries the message log_mileage fails with. Stops
 * may be `Location`s (the chat's confirm payload) as well as the MCP
 * tool's `{ address, lat?, lng? }` shape. */
export async function resolveMileage(
  accountId: string,
  args: {
    locations: (
      | string
      | { address: string; lat?: number | null; lng?: number | null }
    )[];
    date?: string;
    type?: MileageType;
    report?: string;
    /** True when the drive returns to the first stop. A trip is one way
     * unless the caller says otherwise, so the default is false. */
    roundTrip?: boolean;
  },
): Promise<{ ok: true; trip: ResolvedTrip } | { ok: false; error: string }> {
  const input = await validatedExpenseInput(accountId, args);
  if (!input.ok) return { ok: false, error: input.error };
  const { date, report } = input;
  const roundTrip = args.roundTrip ?? false;

  const stops: Location[] = args.locations.map((l) =>
    typeof l === "string"
      ? { address: l, lat: null, lng: null }
      : { address: l.address, lat: l.lat ?? null, lng: l.lng ?? null },
  );
  if (!hasEnoughStops(stops)) {
    return { ok: false, error: "A trip needs at least two stops." };
  }

  const type = args.type ?? "business";
  // The IRS rate for the trip's (date, type). No rate in the master table
  // for the period means no amount (never $0.00).
  const rate = mileageRateFor(await readMileageRates(), date, type);
  const {
    locations,
    distanceMiles,
    amount,
    approximate,
    coords,
    returnCoords,
  } = await recomputeMileage(stops, rate, { roundTrip });

  return {
    ok: true,
    trip: {
      date,
      report,
      type,
      locations,
      distanceMiles,
      amount,
      rate,
      approximate,
      roundTrip,
      coords,
      returnCoords,
    },
  };
}

/** Build and persist the expense for an already-resolved trip. */
export async function saveMileageTrip(
  accountId: string,
  trip: ResolvedTrip,
  args: { category?: string; description?: string },
): Promise<{ expenseId: string; distanceMiles: string; amount: string }> {
  const expense: MileageExpense = {
    ...(newExpenseShell("mileage") as MileageExpense),
    date: trip.date,
    report: trip.report,
    category: args.category?.trim() ?? "",
    description: args.description ?? "",
    mileageType: trip.type,
    amount: trip.amount,
    locations: trip.locations,
    distanceMiles: trip.distanceMiles,
    roundTrip: trip.roundTrip,
    route: { coords: trip.coords, returnCoords: trip.returnCoords },
  };
  await upsertExpense(expense, accountId);
  return {
    expenseId: expense.id,
    distanceMiles: trip.distanceMiles,
    amount: trip.amount,
  };
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
    roundTrip?: boolean;
  },
): Promise<ToolResult> {
  const resolved = await resolveMileage(accountId, args);
  if (!resolved.ok) return fail(resolved.error);
  const { trip } = resolved;
  const saved = await saveMileageTrip(accountId, trip, args);

  return ok({
    logged: true,
    expenseId: saved.expenseId,
    stops: trip.locations.map((l) => l.address),
    distanceMiles: saved.distanceMiles,
    amount: saved.amount,
    type: trip.type,
    rate: trip.rate || null,
    approximate: trip.approximate,
    roundTrip: trip.roundTrip,
    ...(trip.approximate
      ? {
          note: "Route service unavailable — distance is straight-line; re-save the expense later to recompute.",
        }
      : {}),
  });
}

/** A purchase resolved to the fields the app files, before anything is
 * written: what the chat shows the user to confirm. */
export interface ResolvedExpense {
  date: string;
  report: string;
  category: string;
  merchant: string;
  description: string;
  amount: string;
}

/** Validate a typed purchase and resolve its category. Writes nothing: this
 * is the read half of the chat's plan_expense tool, and `error` is what the
 * model is told. */
export async function resolveExpense(
  accountId: string,
  args: {
    merchant?: string;
    amount: string;
    category?: string;
    date?: string;
    report?: string;
    description?: string;
  },
): Promise<
  { ok: true; expense: ResolvedExpense } | { ok: false; error: string }
> {
  const serverUtcNow = new Date().toISOString();
  const date = args.date ?? serverUtcNow.slice(0, 10);
  const report = args.report?.trim() ?? "";
  // The editor's own rules: a real calendar date, and a report that exists
  // and is open (an expense never lands in a closed one).
  const inputError = await validateExpenseInputs(accountId, date, report, {
    checkReport: true,
  });
  if (inputError) return { ok: false, error: inputError };
  const amount = normalizeAmount(args.amount);
  if (!amount) {
    return { ok: false, error: "An expense needs an amount, like 12.50." };
  }
  const merchant = (args.merchant ?? "").trim();
  const { categories, knownMerchants } = await readExtractionContext(accountId);
  return {
    ok: true,
    expense: {
      date,
      report,
      merchant,
      description: (args.description ?? "").trim(),
      amount,
      // A merchant that already has a category keeps it; otherwise the
      // model's suggestion is matched onto one of the account's own names
      // ("" when nothing fits, which only means the row shows as incomplete).
      category: resolveCategory(
        merchant,
        args.category ?? "",
        knownMerchants,
        categories,
      ),
    },
  };
}

/** Build and persist a typed purchase. No image: the user described it, and
 * the editor can attach a receipt later. */
export async function saveReceiptExpense(
  accountId: string,
  expense: ResolvedExpense,
): Promise<{ expenseId: string }> {
  const receipt: ReceiptExpense = {
    ...(newExpenseShell("receipt") as ReceiptExpense),
    date: expense.date,
    report: expense.report,
    category: expense.category,
    description: expense.description,
    amount: expense.amount,
    merchant: expense.merchant,
  };
  await upsertExpense(receipt, accountId);
  return { expenseId: receipt.id };
}

function urlFilename(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    return last ?? "";
  } catch {
    return "";
  }
}
