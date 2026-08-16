import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Loader2, Trash2, Upload } from "lucide-react";
import { useLocation } from "react-router";
import { Button } from "~/components/ui/Button";
import { Field } from "~/components/ui/Field";
import { Input } from "~/components/ui/Input";
import { isComplete } from "~/lib/completeness";
import { findDuplicates } from "~/lib/duplicates";
import { usePasteImage } from "~/lib/use-paste-image";
import type { ReceiptExpense } from "~/lib/types";
import {
  ClosedReportBanner,
  DateAmountFields,
  DeleteConfirmDialog,
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
  submitDelete,
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
  // Edit mode: whether the expense has a stored image. Local state because
  // the replace/delete fetch doesn't revalidate the loader — without it an
  // expense that started imageless would never show the dropped image.
  const [hasImage, setHasImage] = useState(!!expense.imageFile);
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
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const complete = useMemo(
    () => isComplete({ ...expense, date, merchant, amount, report, category }),
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
        fillFields(await ocrFile(file), "empty-only");
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

  /** OCR a just-uploaded receipt file and return the extracted fields, or
   * null when the scan fails (fields stay untouched). Shared by the PDF
   * draft flow (fields fill when the scan is ready) and the edit-mode
   * replace (fields update to the new receipt). */
  async function ocrFile(file: File) {
    const form = new FormData();
    form.set("intent", "ocr");
    form.set("file", file);
    try {
      const res = await fetch("/api/expense", { method: "POST", body: form });
      if (!res.ok) return null;
      return (await res.json()) as {
        merchant?: string;
        amount?: string;
        category?: string;
        report?: string;
      };
    } catch {
      return null;
    }
  }

  /** Apply extracted fields to the form. Create mode fills only what's
   * still empty (a slow OCR response must never overwrite typing); edit
   * mode lets a confident extraction replace the old receipt's values,
   * keeping whatever the scan left blank. */
  function fillFields(
    fields: {
      merchant?: string;
      amount?: string;
      category?: string;
      report?: string;
    } | null,
    mode: "empty-only" | "override",
  ) {
    if (!fields) return;
    const pick = (extracted: string | undefined, current: string) =>
      mode === "override" ? extracted || current : current || extracted || "";
    setMerchant((prev) => pick(fields.merchant, prev));
    setAmount((prev) => pick(fields.amount, prev));
    setCategory((prev) => pick(fields.category, prev));
    setReport((prev) => pick(fields.report, prev));
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
    setHasImage(true);
    // Re-read the new receipt's fields so the form matches the image.
    fillFields(await ocrFile(file), "override");
  }

  // Paste an image anywhere to replace the receipt image.
  usePasteImage(replaceImage);

  /** The file types the drop zone accepts — matches the upload input. */
  function isReceiptFile(file: File): boolean {
    return (
      file.type.startsWith("image/") ||
      file.type === "application/pdf" ||
      /\.pdf$/i.test(file.name)
    );
  }

  // dragenter/dragleave fire for every child element crossed, so track depth
  // instead of toggling on each event — prevents the highlight from
  // flickering. Closed reports are read-only: no highlight, and the drop is
  // left to the browser's default (which ignores it).
  function onDragEnter(e: DragEvent<HTMLElement>) {
    if (reportClosed) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  }

  function onDragOver(e: DragEvent<HTMLElement>) {
    if (reportClosed) return;
    // preventDefault is required to turn the drag into a drop target.
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(e: DragEvent<HTMLElement>) {
    if (reportClosed) return;
    e.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragOver(false);
    }
  }

  function onDrop(e: DragEvent<HTMLElement>) {
    if (reportClosed) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && isReceiptFile(file)) void replaceImage(file);
  }

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
    submitDelete(fetcher);
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
      drop={{ over: dragOver, onDragEnter, onDragOver, onDragLeave, onDrop }}
    >
      <div className="sr-only" role="status" aria-live="polite">
        {dragOver ? "Receipt file detected — drop to replace" : ""}
      </div>
      <ErrorBanner error={error} />
      {reportClosed ? <ClosedReportBanner /> : null}
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
            {(isNew ? !!draftPreview : hasImage) && !reportClosed ? (
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
                  setHasImage(false);
                }}
              >
                <Trash2 aria-hidden="true" className="h-4 w-4" />
              </Button>
            ) : null}
          </span>
        </div>
        {(isNew ? draftPreview : hasImage) ? (
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
              "No image. Upload, drag & drop, or paste one (⌘V)."
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

      {lightbox && (isNew ? draftPreview : hasImage) ? (
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
      <DeleteConfirmDialog
        open={confirmDelete}
        onConfirm={() => doDelete(onDelete)}
        onCancel={() => setConfirmDelete(false)}
        busy={fetcher.state !== "idle"}
      />
      {transition ? <TransitionOverlay kind={transition} /> : null}
    </Shell>
  );
}
