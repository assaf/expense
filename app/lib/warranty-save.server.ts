import { readExpense } from "~/lib/db/expenses";
import { upsertWarranty } from "~/lib/db/warranties";
import { captureWarning } from "~/lib/errors.server";
import { isImage, isPdf } from "~/lib/file-types";
import { normalizeAmount } from "~/lib/format";
import { exceedsMaxMoney } from "~/lib/money";
import {
  readUploadedFile,
  readUploadedFiles,
  saveImage,
  uploadErrorMessage,
} from "~/lib/images.server";
import { newWarrantyShell, type Warranty } from "~/lib/types";
import { formString, validateDate } from "~/lib/validation";
import {
  EMPTY_WARRANTY_EXTRACTION,
  extractWarrantyFields,
  productFromFileName,
} from "~/lib/warranty-ai.server";

/** Read the label paired with the i-th uploaded document, or "Document"
 * when the field is missing/blank. */
function documentLabel(form: FormData, index: number): string {
  const labels = form
    .getAll("documentLabels")
    .filter((v): v is string => typeof v === "string");
  return labels[index]?.trim() || "Document";
}

/**
 * Persist a warranty from a save form submission. Shared by the create route
 * (/warranty/new, `existing` = null) and the edit route (/warranty/:id,
 * `existing` = the current row).
 *
 * Documents are appended, never replaced: removing one is its own intent
 * (the edit route's "removeDocument"), so a save can't drop a stored
 * document the user didn't ask to remove. Nothing uploads before this runs,
 * so an abandoned editor leaves no orphan blobs.
 *
 * Returns the saved warranty's id on success, or an error message to
 * surface on the form.
 */
export async function saveWarrantyFromForm(
  form: FormData,
  accountId: string,
  existing: Warranty | null,
): Promise<{ error: string; id: null } | { error: null; id: string }> {
  const merchant = formString(form, "merchant").trim();
  // The product is what the record is about, so it is the one required
  // field; the merchant can be unknown (a document dropped on the list page
  // often names the product and the terms but not the seller).
  const product = formString(form, "product").trim();
  if (!product) return { error: "A warranty needs a product.", id: null };

  const value = normalizeAmount(formString(form, "value"));
  // A value the numeric(10,2) column cannot hold must be refused here:
  // otherwise the insert raises `numeric field overflow` and the user gets
  // an error page instead of a message on the form.
  if (exceedsMaxMoney(value)) {
    return { error: "That value is too large to save.", id: null };
  }

  const purchasedAt = formString(form, "purchasedAt").trim();
  const expiresAt = formString(form, "expiresAt").trim();
  if (validateDate(purchasedAt)) {
    return { error: "Use a valid purchase date.", id: null };
  }
  if (validateDate(expiresAt)) {
    return { error: "Use a valid expiry date.", id: null };
  }

  // Resolve every upload before persisting any, so one over-cap file can't
  // leave the earlier ones stored and unreferenced.
  const uploads = await readUploadedFiles(form, "documents");
  if (uploads.some((u) => !u.ok && u.error === "too-large")) {
    return { error: uploadErrorMessage("too-large"), id: null };
  }
  const added: Warranty["documents"] = [];
  let index = 0;
  for (const upload of uploads) {
    const label = documentLabel(form, index++);
    if (!upload.ok) continue;
    const { filename } = await saveImage(
      accountId,
      upload.buffer,
      upload.mime,
      upload.originalName,
    );
    added.push({ key: filename, name: upload.originalName, label });
  }

  // Link only to an expense that exists in this account: a stale id (a
  // deleted expense, or another account's) silently unlinks rather than
  // failing a save whose other fields are fine.
  const requestedExpenseId = formString(form, "expenseId").trim();
  const expenseId =
    requestedExpenseId &&
    (await readExpense(requestedExpenseId, accountId)) !== undefined
      ? requestedExpenseId
      : "";

  const warranty: Warranty = {
    ...(existing ?? newWarrantyShell()),
    merchant,
    product,
    value,
    purchasedAt,
    expiresAt,
    terms: formString(form, "terms"),
    documents: [...(existing?.documents ?? []), ...added],
    expenseId,
    updatedAt: new Date().toISOString(),
  };
  await upsertWarranty(warranty, accountId);
  return { error: null, id: warranty.id };
}

/**
 * File a warranty straight from a dropped document: store the file as the
 * record's document, read what the document says (see
 * app/lib/warranty-ai.server.ts), and create the record. The document is the
 * point, so a document the model couldn't read still becomes a warranty with
 * its file attached; only an unreadable *upload* refuses.
 *
 * Nothing is stored until the reading succeeds, so a failed extraction (or a
 * lost request) leaves no orphan blob behind.
 */
export async function createWarrantyFromDocument(
  form: FormData,
  accountId: string,
): Promise<{ error: string; id: null } | { error: null; id: string }> {
  const uploaded = await readUploadedFile(form);
  if (!uploaded.ok) {
    return { error: uploadErrorMessage(uploaded.error), id: null };
  }
  const { buffer, mime, originalName } = uploaded;
  // The picker's `accept` is advisory (browsers ignore it on a drop), so the
  // bytes decide: only an image or a PDF can be read as a warranty document.
  if (
    !isImage({ buffer, mime, originalName }) &&
    !isPdf({ buffer, mime, originalName })
  ) {
    return { error: "Drop an image or a PDF.", id: null };
  }

  const extraction = await extractWarrantyFields({
    accountId,
    buffer,
    mime,
  }).catch((err: unknown) => {
    captureWarning("[warranty] extraction failed", { error: err });
    return EMPTY_WARRANTY_EXTRACTION;
  });

  const saved = await saveImage(accountId, buffer, mime, originalName);
  const warranty: Warranty = {
    ...newWarrantyShell(),
    merchant: extraction.merchant,
    // The document's own name is the fallback: the record is identified by
    // its product, and the file the user dropped is the next best evidence.
    product:
      extraction.product ||
      productFromFileName(originalName) ||
      "Warranty document",
    value: extraction.value,
    purchasedAt: extraction.purchasedAt,
    expiresAt: extraction.expiresAt,
    terms: extraction.terms,
    documents: [{ key: saved.filename, name: originalName, label: "Document" }],
    updatedAt: new Date().toISOString(),
  };
  await upsertWarranty(warranty, accountId);
  return { error: null, id: warranty.id };
}
