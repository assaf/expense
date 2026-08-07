import { normalizeAmount } from "~/lib/format";
import { renameImageToConvention } from "~/lib/images.server";
import { isMileageType } from "~/lib/mileage-rates";
import {
  findOpenReport,
  newExpenseShell,
  upsertExpense,
} from "~/lib/store.server";
import {
  EMPTY_ROUTE,
  parseLocations,
  parseRoute,
  type Expense,
  type MileageExpense,
  type ReceiptExpense,
} from "~/lib/types";
import { formString, validateDateNotFuture } from "~/lib/validation";

/**
 * Validate the inputs every expense write shares — the date (a valid
 * calendar date, not in the future) and the report (must exist and be
 * open, when one is assigned). Returns an error message, or null when the
 * inputs are fine. Callers skip the report check when the expense keeps
 * its existing report unchanged (an expense already in a closed report
 * stays there when saved without changes).
 */
export async function validateExpenseInputs(
  accountId: string,
  date: string,
  report: string,
  opts: { checkReport?: boolean } = {},
): Promise<string | null> {
  const dateError = validateDateNotFuture(date);
  if (dateError) return dateError;
  if (opts.checkReport && report) {
    const { error } = await findOpenReport(accountId, report);
    if (error) return error;
  }
  return null;
}

/**
 * Persist an expense from a save form submission. Shared by the edit route
 * (/expense/:id, `existing` = the current row) and the create route
 * (/expense/new, `existing` = null — the expense is a fresh shell, and the
 * form's `type` field decides receipt vs mileage).
 *
 * Applies the same validation as the original per-route actions:
 *  - date must be a valid calendar date, not in the future
 *  - a report that is closed can't be assigned — but an expense already in
 *    a closed report keeps it when saved unchanged
 *  - the amount is normalized to two fractional digits
 *  - a receipt image is renamed to its convention name when date + report
 *    are now set
 *
 * Returns the saved expense's id on success (the caller may redirect with
 * it, e.g. to highlight the new row), or an error message to surface.
 */
export async function saveExpenseFromForm(
  form: FormData,
  accountId: string,
  existing: Expense | null,
): Promise<{ error: string; id: null } | { error: null; id: string }> {
  const date = formString(form, "date");
  const report = formString(form, "report");
  const inputError = await validateExpenseInputs(accountId, date, report, {
    // The report must exist and be open — an expense already in a closed
    // report keeps it when saved unchanged (the check is skipped then).
    checkReport: Boolean(report && (!existing || report !== existing.report)),
  });
  if (inputError) return { error: inputError, id: null };

  const category = formString(form, "category");
  const description = formString(form, "description");
  const amount = normalizeAmount(formString(form, "amount"));
  const now = new Date().toISOString();

  const isMileage = existing
    ? existing.type === "mileage"
    : formString(form, "type") === "mileage";
  if (isMileage) {
    // The IRS trip type (business/charity/medical/moving) — invalid or
    // missing values fall back to the business default.
    const rawType = formString(form, "mileageType");
    const mileageType: MileageExpense["mileageType"] = isMileageType(rawType)
      ? rawType
      : "business";
    // The form carries the latest computed route geometry (empty when the
    // session never recomputed — keep the stored route then, so a legacy
    // expense saved unchanged doesn't wipe its geometry).
    const sentRoute = parseRoute(formString(form, "route"));
    const route =
      sentRoute.coords.length >= 2
        ? sentRoute
        : existing && existing.type === "mileage"
          ? existing.route
          : EMPTY_ROUTE;
    const expense: MileageExpense = {
      ...(existing && existing.type === "mileage"
        ? existing
        : (newExpenseShell("mileage") as MileageExpense)),
      date,
      report,
      category,
      description,
      amount,
      mileageType,
      // Empty/blank addresses are never persisted — the editor keeps blank
      // rows as placeholders, but a saved trip only stores real stops.
      locations: parseLocations(formString(form, "locations")).filter(
        (l) => l.address.trim() !== "",
      ),
      distanceMiles: formString(form, "distanceMiles"),
      route,
      updatedAt: now,
    };
    await upsertExpense(expense, accountId);
    return { error: null, id: expense.id };
  }

  const receipt: ReceiptExpense = {
    ...(existing && existing.type === "receipt"
      ? existing
      : (newExpenseShell("receipt") as ReceiptExpense)),
    date,
    report,
    category,
    description,
    amount,
    merchant: formString(form, "merchant").trim(),
    // Create mode: a draft image (held by /api/expense) becomes the
    // expense's image; the convention rename below moves it into the
    // dated/report-named key. Edit mode keeps the stored image fields.
    ...(existing
      ? {}
      : {
          imageFile: formString(form, "draftKey"),
          imageMime: formString(form, "draftMime"),
          originalName: formString(form, "draftOriginalName"),
        }),
    updatedAt: now,
  };
  if (receipt.imageFile) {
    receipt.imageFile = await renameImageToConvention(
      accountId,
      receipt.imageFile,
      date,
      report,
      receipt.originalName,
      receipt.imageMime,
    );
  }
  await upsertExpense(receipt, accountId);
  return { error: null, id: receipt.id };
}
