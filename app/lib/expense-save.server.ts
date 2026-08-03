import { normalizeAmount } from "~/lib/format";
import { renameImageToConvention } from "~/lib/images.server";
import {
  newExpenseShell,
  readReports,
  upsertExpense,
} from "~/lib/store.server";
import {
  parseLocations,
  type Expense,
  type MileageExpense,
  type ReceiptExpense,
} from "~/lib/types";
import { formString, validateDateNotFuture } from "~/lib/validation";

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
  const dateError = validateDateNotFuture(date);
  if (dateError) return { error: dateError, id: null };

  const report = formString(form, "report");
  if (report && (!existing || report !== existing.report)) {
    const reports = await readReports(accountId);
    if (reports.some((r) => r.name === report && r.closed)) {
      return { error: `Report "${report}" is closed.`, id: null };
    }
  }

  const category = formString(form, "category");
  const description = formString(form, "description");
  const amount = normalizeAmount(formString(form, "amount"));
  const now = new Date().toISOString();

  const isMileage = existing
    ? existing.type === "mileage"
    : formString(form, "type") === "mileage";
  if (isMileage) {
    const expense: MileageExpense = {
      ...(existing && existing.type === "mileage"
        ? existing
        : (newExpenseShell("mileage") as MileageExpense)),
      date,
      report,
      category,
      description,
      amount,
      // Empty/blank addresses are never persisted — the editor keeps blank
      // rows as placeholders, but a saved trip only stores real stops.
      locations: parseLocations(formString(form, "locations")).filter(
        (l) => l.address.trim() !== "",
      ),
      distanceMiles: formString(form, "distanceMiles"),
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
