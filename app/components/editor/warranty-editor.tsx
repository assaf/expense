import { useEffect, useRef, useState } from "react";
import { Paperclip, Trash2, Upload } from "lucide-react";
import { useFetcher, useNavigate } from "react-router";
import { PageShell } from "~/components/PageShell";
import { Button } from "~/components/ui/Button";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { DatePicker } from "~/components/ui/DatePicker";
import { Field } from "~/components/ui/Field";
import { FieldLabel } from "~/components/ui/FieldLabel";
import { Input } from "~/components/ui/Input";
import { LiveStatus } from "~/components/ui/LiveStatus";
import { Select } from "~/components/ui/Select";
import { Textarea } from "~/components/ui/Textarea";
import { Alert } from "~/components/ui/Alert";
import { isReceiptFile } from "~/lib/file-types";
import { formatAmount, formatDate, normalizeAmount } from "~/lib/format";
import { useDropTarget } from "~/lib/use-drop-target";
import type { Warranty, WarrantyExpenseOption } from "~/lib/types";
import {
  EditorActions,
  TransitionOverlay,
  fetcherError,
} from "./editor-shared";

/** Data shape shared by /warranty/new and /warranty/:id. */
export interface WarrantyEditorData {
  mode: "create" | "edit";
  warranty: Warranty;
  /** Prior merchant names for the autocomplete datalist. */
  merchants: string[];
  /** The most recent receipts, for the "linked expense" picker. */
  receipts: WarrantyExpenseOption[];
}

/** One picked-but-not-yet-uploaded document. Nothing uploads before Save,
 * so an abandoned editor leaves no orphan blobs. */
interface PendingDocument {
  file: File;
  label: string;
}

function documentCountLabel(count: number): string {
  return `${count} document${count === 1 ? "" : "s"}`;
}

/** The warranty editor both routes render. Local state per field, with the
 * whole editor inside one multipart form: picked or dropped documents are
 * held in state (and mirrored into the file input) until Save, so an
 * abandoned editor leaves no orphan blobs. */
export function WarrantyEditor({ data }: { data: WarrantyEditorData }) {
  const warranty = data.warranty;
  const isNew = data.mode === "create";
  const navigate = useNavigate();
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();

  const [product, setProduct] = useState(warranty.product);
  const [merchant, setMerchant] = useState(warranty.merchant);
  const [value, setValue] = useState(warranty.value);
  const [purchasedAt, setPurchasedAt] = useState(warranty.purchasedAt);
  const [expiresAt, setExpiresAt] = useState(warranty.expiresAt);
  const [terms, setTerms] = useState(warranty.terms);
  const [expenseId, setExpenseId] = useState(warranty.expenseId);
  const [picks, setPicks] = useState<PendingDocument[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [transition, setTransition] = useState<null | "save" | "delete">(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // Whether the in-flight submission is a save: only then do the picked
  // files become stored documents (a document removal's `ok` must not throw
  // away picks the user just made).
  const savedOnSuccess = useRef(false);

  const saving = fetcher.state !== "idle";
  const error = fetcherError(fetcher.data);
  const savedDocuments = warranty.documents;
  const totalDocuments = savedDocuments.length + picks.length;

  /** Hold every picked file as a pending document (nothing uploads before
   * Save). Shared by the file picker and the page's drop target, so a drop
   * and a pick land identically. */
  function addPicks(files: File[]) {
    if (files.length === 0) return;
    setPicks((prev) => [
      ...prev,
      ...files.map((file) => ({ file, label: "Document" })),
    ]);
  }

  const drop = useDropTarget({
    // A submission in flight must stay authoritative over the document list:
    // dropping during one would add a pick the response then clears.
    enabled: !saving,
    accepts: isReceiptFile,
    onFiles: addPicks,
    message: "Document detected — drop to attach",
  });

  // The picker is the one place the files live for submission, so its
  // FileList has to mirror the picks exactly: removing a row above must
  // remove the file from the form too, and the browser only serializes what
  // the input still holds.
  useEffect(() => {
    const input = fileRef.current;
    if (!input) return;
    const transfer = new DataTransfer();
    for (const pick of picks) transfer.items.add(pick.file);
    input.files = transfer.files;
  }, [picks]);

  // Clear the overlay when a submission lands without navigating (a
  // validation error) and drop the picked files once a save stuck: the
  // revalidated loader data now carries them as stored documents.
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    setTransition(null);
    if (savedOnSuccess.current && "ok" in fetcher.data) {
      savedOnSuccess.current = false;
      setPicks([]);
    }
  }, [fetcher.state, fetcher.data]);

  function cancel() {
    void navigate("/warranties");
  }

  /** Save through the form itself: a JS-built FormData would be encoded as
   * url-encoded, which drops the picked files (they become filenames), so
   * the browser has to do the multipart encoding. */
  function save() {
    if (!formRef.current) return;
    savedOnSuccess.current = true;
    setTransition("save");
    formRef.current.requestSubmit();
  }

  function removeDocument(key: string) {
    savedOnSuccess.current = false;
    const form = new FormData();
    form.set("intent", "removeDocument");
    form.set("key", key);
    void fetcher.submit(form, { method: "post" });
  }

  return (
    <PageShell
      title={product || (isNew ? "New warranty" : "Warranty")}
      onBack={cancel}
      dimmed={!!transition}
      drop={drop}
    >
      <LiveStatus>{drop.message}</LiveStatus>
      {/* A real form, not a JS-built FormData: React Router encodes a
          JS-built one as url-encoded, which turns each picked file into its
          filename. The browser does the multipart encoding here. */}
      <fetcher.Form ref={formRef} method="post" encType="multipart/form-data">
        <input type="hidden" name="intent" value="save" />
        {error ? <Alert className="mb-4">{error}</Alert> : null}

        <Field label="Product">
          <Input
            type="text"
            name="product"
            value={product}
            onChange={(e) => setProduct(e.target.value)}
          />
        </Field>

        <Field label="Merchant" className="mt-4">
          <Input
            type="text"
            name="merchant"
            list="warranties-merchants"
            value={merchant}
            onChange={(e) => setMerchant(e.target.value)}
          />
          <datalist id="warranties-merchants">
            {data.merchants.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>

        <Field label="Value" className="mt-4">
          <Input
            type="number"
            name="value"
            step="0.01"
            inputMode="decimal"
            placeholder="0.00"
            value={value}
            onClick={(e) => e.currentTarget.select()}
            onChange={(e) => setValue(e.target.value)}
            onBlur={(e) => setValue(normalizeAmount(e.target.value))}
          />
        </Field>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Purchased">
            <DatePicker
              name="purchasedAt"
              value={purchasedAt}
              onChange={setPurchasedAt}
            />
          </Field>
          {/* The Clear button stays outside the Field's label: a control
                nested in a label both joins its accessible name and
                activates it. */}
          <div className="flex items-end gap-2">
            <Field label="Expires" className="flex-1">
              <DatePicker
                name="expiresAt"
                value={expiresAt}
                onChange={setExpiresAt}
              />
            </Field>
            {expiresAt ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setExpiresAt("")}
                className="mb-px"
              >
                Clear
              </Button>
            ) : null}
          </div>
        </div>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Leave the expiry blank for a warranty with no end date.
        </p>

        <Field label="Terms" className="mt-4">
          <Textarea
            name="terms"
            rows={4}
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
          />
        </Field>

        <Field label="Linked expense" className="mt-4">
          <Select
            name="expenseId"
            value={expenseId}
            onChange={(e) => setExpenseId(e.target.value)}
          >
            <option value="">—</option>
            {data.receipts.map((r) => (
              <option key={r.id} value={r.id}>
                {`${r.merchant || "No merchant"} — ${formatDate(r.date)} — ${formatAmount(r.amount)}`}
              </option>
            ))}
          </Select>
        </Field>

        <div className="mt-6">
          <div className="mb-1 flex items-center justify-between">
            <FieldLabel>Documents</FieldLabel>
            <span
              className="text-xs text-gray-500 dark:text-gray-400"
              role="status"
            >
              {documentCountLabel(totalDocuments)}
            </span>
          </div>
          <ul className="flex flex-col gap-2">
            {savedDocuments.map((doc, index) => (
              <li
                key={doc.key}
                className="flex items-center gap-3 rounded-lg bg-gray-50 px-3 py-1.5 dark:bg-gray-900"
              >
                <Paperclip
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500"
                />
                <a
                  href={`/warranty/${warranty.id}/document/${index}`}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate text-sm text-blue-700 hover:underline dark:text-blue-400"
                >
                  <span className="font-medium">{doc.label}</span>{" "}
                  <span className="text-gray-500 dark:text-gray-400">
                    {doc.name || "Document"}
                  </span>
                </a>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  aria-label={`Remove ${doc.label}`}
                  onClick={() => removeDocument(doc.key)}
                >
                  <Trash2 aria-hidden="true" className="h-4 w-4" />
                </Button>
              </li>
            ))}
            {picks.map((pick, index) => (
              <li
                key={`${pick.file.name}-${index}`}
                className="flex items-center gap-3 rounded-lg bg-gray-50 px-3 py-1.5 dark:bg-gray-900"
              >
                <Input
                  type="text"
                  name="documentLabels"
                  aria-label={`Label for ${pick.file.name}`}
                  value={pick.label}
                  className="w-32 py-1 text-sm"
                  onChange={(e) =>
                    setPicks((prev) =>
                      prev.map((p, i) =>
                        i === index ? { ...p, label: e.target.value } : p,
                      ),
                    )
                  }
                />
                <span className="min-w-0 flex-1 truncate text-sm text-gray-500 dark:text-gray-400">
                  {pick.file.name}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  aria-label={`Remove ${pick.file.name}`}
                  onClick={() =>
                    setPicks((prev) => prev.filter((_, i) => i !== index))
                  }
                >
                  <Trash2 aria-hidden="true" className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
          {/* The picked files live here, kept in step with the rows above: the
            label inputs come first in the DOM, so the server pairs
            `documentLabels[i]` with `documents[i]` by position. */}
          <input
            ref={fileRef}
            type="file"
            name="documents"
            multiple
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => {
              addPicks([...(e.currentTarget.files ?? [])]);
              e.currentTarget.value = "";
            }}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={saving}
            className="mt-2"
            onClick={() => fileRef.current?.click()}
          >
            <Upload aria-hidden="true" className="h-4 w-4" /> Add documents
          </Button>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Or drop a receipt, a terms PDF, or a card statement anywhere on this
            page.
          </p>
        </div>

        <EditorActions
          complete
          saving={saving}
          onCancel={cancel}
          onSave={save}
          onDelete={isNew ? undefined : () => setConfirmDelete(true)}
        />
      </fetcher.Form>

      {confirmDelete ? (
        <ConfirmDialog
          message="Delete this warranty? This cannot be undone."
          onConfirm={() => {
            setConfirmDelete(false);
            setTransition("delete");
            const form = new FormData();
            form.set("intent", "delete");
            void fetcher.submit(form, { method: "post" });
          }}
          onCancel={() => setConfirmDelete(false)}
          deleting={saving}
        />
      ) : null}
      {transition ? <TransitionOverlay kind={transition} /> : null}
    </PageShell>
  );
}
