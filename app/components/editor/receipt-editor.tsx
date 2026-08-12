import { useEffect, useMemo, useRef, useState } from "react";
import { Lock, Loader2, Trash2, Upload } from "lucide-react";
import { useLocation } from "react-router";
import { Button } from "~/components/ui/Button";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Field } from "~/components/ui/Field";
import { Input } from "~/components/ui/Input";
import { isComplete } from "~/lib/completeness";
import { findDuplicates } from "~/lib/duplicates";
import { usePasteImage } from "~/lib/use-paste-image";
import type { ReceiptExpense } from "~/lib/types";
import {
  DateAmountFields,
  DescriptionField,
  DraftProgress,
  DuplicateWarning,
  EditorActions,
  ErrorBanner,
  Lightbox,
  ReportCategoryFields,
  Shell,
  TransitionOverlay,
  fetcherError,
  useEditorFlow,
  useFormKeys,
  type EditorData,
} from "./editor-shared";

/**
 * Files carried from the home page (paste/upload) that are being uploaded as
 * editor drafts. Module scope so the guard survives StrictMode's dev
 * double-mount — without it a carried file would be uploaded and OCR'd
 * twice, orphaning the first draft blob.
 */
const draftUploadsInFlight = new WeakSet<File>();

export function ReceiptEditor({ data }: { data: EditorData }) {
  const { reports, categories, merchants, reportClosed } = data;
  const expense = data.expense as ReceiptExpense;
  const isNew = data.mode === "create";
  const { fetcher, transition, doSave, doDelete, doCancel } = useEditorFlow();

  const [date, setDate] = useState(expense.date);
  const [merchant, setMerchant] = useState(expense.merchant);
  const [amount, setAmount] = useState(expense.amount);
  const [report, setReport] = useState(expense.report);
  const [category, setCategory] = useState(expense.category);
  const [description, setDescription] = useState(expense.description);
  const [imageVersion, setImageVersion] = useState(0);
  const [lightbox, setLightbox] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draft, setDraft] = useState<{
    key: string;
    mime: string;
    originalName: string;
  } | null>(null);
  const [draftPreview, setDraftPreview] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftStage, setDraftStage] = useState<"convert" | "ocr" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  const complete = useMemo(
    () =>
      isComplete({
        ...expense,
        date,
        merchant,
        amount,
        report,
        category,
      } as ReceiptExpense),
    [expense, date, merchant, amount, report, category],
  );

  // Create mode: does the draft look like an expense that already exists?
  // Computed live as the fields change; the banner warns but never blocks.
  const duplicateMatches = useMemo(
    () =>
      isNew
        ? findDuplicates(
            { ...expense, date, merchant, amount, report, category },
            data.existing,
          )
        : [],
    [isNew, expense, date, merchant, amount, report, category, data.existing],
  );

  // Create mode: a file carried from the home page (paste/upload) becomes the
  // draft image, and OCR pre-fills the fields when it returns. StrictMode's
  // dev double-mount must not upload the carried file twice (it would OCR
  // and store two drafts, orphaning the first), so in-flight files are
  // tracked at module scope where they survive the remount.
  const location = useLocation();
  useEffect(() => {
    const file = (location.state as { file?: File } | null)?.file;
    if (isNew && file && !draftUploadsInFlight.has(file)) {
      draftUploadsInFlight.add(file);
      void uploadDraft(file);
    }
  }, []);

  async function uploadDraft(file: File) {
    // Images render straight from a blob URL. PDFs can't (an <img> can't
    // display a PDF), so their preview is the rasterized PNG served from
    // storage once the upload completes.
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (!isPdf) setDraftPreview(URL.createObjectURL(file));
    setDraftError(null);
    setDrafting(true);
    // PDFs rasterize before they can be displayed; images show a preview
    // immediately and only read fields. The stage label tells the user which
    // phase is running while they wait.
    setDraftStage(isPdf ? "convert" : "ocr");
    const form = new FormData();
    form.set("intent", "draft-upload");
    form.set("file", file);
    try {
      const res = await fetch("/api/expense", { method: "POST", body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setDraftError(body?.error ?? "Couldn't load that file.");
        return;
      }
      const json = (await res.json()) as {
        draftKey: string;
        mime: string;
        originalName: string;
        merchant?: string;
        amount?: string;
        category?: string;
        report?: string;
      };
      // Replace any earlier draft so a draft never outlives the editor.
      if (draft) await deleteDraftBlob(draft.key);
      setDraft({
        key: json.draftKey,
        mime: json.mime,
        originalName: json.originalName,
      });
      if (isPdf) {
        // PDF uploads return before OCR runs (a slow scan must never block
        // the draft); extract as a second request so fields fill when ready.
        setDraftPreview(
          `/api/expense?draftKey=${encodeURIComponent(json.draftKey)}`,
        );
        setDraftStage("ocr");
        await ocrDraft(file);
        return;
      }
      // Extraction only fills fields the user hasn't typed yet — a slow OCR
      // response arriving after the user started editing must not overwrite
      // what they wrote.
      setMerchant((prev) => prev || json.merchant || "");
      setAmount((prev) => prev || json.amount || "");
      setCategory((prev) => prev || json.category || "");
      setReport((prev) => prev || json.report || "");
    } catch {
      // Keep the preview; the user can still fill the fields by hand.
    } finally {
      setDrafting(false);
      setDraftStage(null);
    }
  }

  /** PDFs: OCR runs after the draft is stored, filling the fields in when
   * the scan is ready. Failures leave the fields empty — never the draft. */
  async function ocrDraft(file: File) {
    const form = new FormData();
    form.set("intent", "draft-ocr");
    form.set("file", file);
    try {
      const res = await fetch("/api/expense", { method: "POST", body: form });
      if (!res.ok) return;
      const json = (await res.json()) as {
        merchant?: string;
        amount?: string;
        category?: string;
        report?: string;
      };
      // Same rule as the draft upload: fill only what's still empty.
      setMerchant((prev) => prev || json.merchant || "");
      setAmount((prev) => prev || json.amount || "");
      setCategory((prev) => prev || json.category || "");
      setReport((prev) => prev || json.report || "");
    } catch {
      // Fields stay empty; the user can fill them by hand.
    }
  }

  async function deleteDraftBlob(key: string) {
    const form = new FormData();
    form.set("intent", "draft-delete");
    form.set("draftKey", key);
    await fetch("/api/expense", { method: "POST", body: form }).catch(() => {});
  }

  async function removeDraft() {
    if (draft) await deleteDraftBlob(draft.key);
    setDraft(null);
    setDraftPreview(null);
    setDraftError(null);
  }

  /** Cancel without saving: drop any draft image, then leave the editor. */
  function onCancel() {
    if (isNew && draft) void deleteDraftBlob(draft.key);
    doCancel();
  }

  async function replaceImage(file: File) {
    if (isNew) {
      await uploadDraft(file);
      return;
    }
    const form = new FormData();
    form.set("intent", "upload");
    form.set("file", file);
    await fetch(`/expense/${expense.id}/image`, { method: "POST", body: form });
    setImageVersion((v) => v + 1);
  }

  // Paste an image anywhere to replace the receipt image.
  usePasteImage(replaceImage);

  function onSave() {
    const form = new FormData();
    form.set("intent", "save");
    form.set("date", date);
    form.set("merchant", merchant);
    form.set("amount", amount);
    form.set("report", report);
    form.set("category", category);
    form.set("description", description);
    if (isNew) {
      form.set("type", "receipt");
      form.set("draftKey", draft?.key ?? "");
      form.set("draftMime", draft?.mime ?? "");
      form.set("draftOriginalName", draft?.originalName ?? "");
    }
    void fetcher.submit(form, { method: "post" });
  }

  // Autofocus the amount field when the editor first opens.
  useEffect(() => {
    amountRef.current?.focus();
  }, []);

  function onDelete() {
    const form = new FormData();
    form.set("intent", "delete");
    void fetcher.submit(form, { method: "post" });
  }

  const error = fetcherError(fetcher.data);
  useFormKeys({
    onSave: () => doSave(onSave),
    onCancel,
    disabled: fetcher.state !== "idle" || drafting || reportClosed,
    blocked: lightbox || confirmDelete,
  });

  return (
    <Shell
      title={expense.merchant || "New receipt"}
      nav={data.nav}
      dimmed={!!transition}
      onBack={isNew ? onCancel : undefined}
    >
      <ErrorBanner error={error} />
      {reportClosed ? (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-3 py-2 text-sm text-gray-600 dark:text-gray-400">
          <Lock aria-hidden="true" className="h-4 w-4" />
          This expense is in a closed report.
        </div>
      ) : null}
      {duplicateMatches.length > 0 ? (
        <DuplicateWarning matches={duplicateMatches} />
      ) : null}

      <div className="mb-6">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
            Receipt image
          </span>
          <span className="flex gap-1">
            {!reportClosed ? (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.currentTarget.files?.[0];
                    if (f) void replaceImage(f);
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload aria-hidden="true" className="h-4 w-4" /> Replace
                </Button>
              </>
            ) : null}
            {(isNew ? draftPreview : expense.imageFile) && !reportClosed ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Remove receipt image"
                onClick={async () => {
                  if (isNew) {
                    await removeDraft();
                    return;
                  }
                  await fetch(`/expense/${expense.id}/image`, {
                    method: "POST",
                    body: (() => {
                      const f = new FormData();
                      f.set("intent", "delete");
                      return f;
                    })(),
                  });
                  setImageVersion((v) => v + 1);
                }}
              >
                <Trash2 aria-hidden="true" className="h-4 w-4" />
              </Button>
            ) : null}
          </span>
        </div>
        {(isNew ? draftPreview : expense.imageFile) ? (
          <button
            type="button"
            onClick={() => setLightbox(true)}
            aria-label="View receipt full screen"
            className="block w-full overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900"
          >
            <img
              key={imageVersion}
              src={
                isNew
                  ? (draftPreview ?? "")
                  : `/expense/${expense.id}/image?v=${imageVersion}`
              }
              alt="Receipt"
              className="min-h-53 max-h-120 w-full object-cover object-top"
            />
          </button>
        ) : (
          <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-gray-300 dark:border-gray-600 text-sm text-gray-500 dark:text-gray-400">
            {isNew && drafting && !draftPreview ? (
              <span className="flex items-center gap-2">
                <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />{" "}
                Preparing your receipt…
              </span>
            ) : (
              "No image. Upload or paste one (⌘V)."
            )}
          </div>
        )}
        {draftError ? (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">
            {draftError}
          </p>
        ) : isNew && drafting ? (
          <DraftProgress stage={draftStage} />
        ) : (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Click the image to view full screen.
          </p>
        )}
      </div>

      <DateAmountFields
        date={date}
        onDate={setDate}
        amount={amount}
        onAmount={setAmount}
        amountRef={amountRef}
        disabled={reportClosed}
      />

      <Field label="Merchant" className="mt-4">
        <Input
          type="text"
          list="merchants"
          value={merchant}
          disabled={reportClosed}
          onChange={(e) => setMerchant(e.target.value)}
        />
        <datalist id="merchants">
          {merchants.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </Field>

      <ReportCategoryFields
        report={report}
        onReport={setReport}
        reports={reports}
        category={category}
        onCategory={setCategory}
        categories={categories}
        disabled={reportClosed}
      />

      <DescriptionField
        value={description}
        onChange={setDescription}
        disabled={reportClosed}
      />

      <EditorActions
        complete={complete}
        saving={fetcher.state !== "idle" || drafting}
        onCancel={onCancel}
        onSave={() => doSave(onSave)}
        onDelete={isNew ? undefined : () => setConfirmDelete(true)}
        saveLabel={duplicateMatches.length > 0 ? "Save anyway" : undefined}
        readOnly={reportClosed}
      />

      {lightbox && (isNew ? draftPreview : expense.imageFile) ? (
        <Lightbox
          src={
            isNew
              ? (draftPreview ?? "")
              : `/expense/${expense.id}/image?v=${imageVersion}`
          }
          onClose={() => {
            setLightbox(false);
            amountRef.current?.focus();
            amountRef.current?.select();
          }}
        />
      ) : null}
      {confirmDelete ? (
        <ConfirmDialog
          message="Delete this expense? This cannot be undone."
          onConfirm={() => doDelete(onDelete)}
          onCancel={() => setConfirmDelete(false)}
          deleting={fetcher.state !== "idle"}
        />
      ) : null}
      {transition ? <TransitionOverlay kind={transition} /> : null}
    </Shell>
  );
}
