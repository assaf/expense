import { useEffect, useMemo, useRef, useState } from "react";
import {
  Trash2,
  Upload,
  X,
  Plus,
  MapPinned,
  Loader2,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
} from "lucide-react";
import {
  useFetcher,
  useLocation,
  useNavigate,
  Link,
  redirect,
} from "react-router";
import MapView from "~/components/MapView";
import { PageShell } from "~/components/PageShell";
import { Button } from "~/components/ui/Button";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Field } from "~/components/ui/Field";
import { Input } from "~/components/ui/Input";
import { Select } from "~/components/ui/Select";
import { Textarea } from "~/components/ui/Textarea";
import { requireUser } from "~/lib/auth.server";
import { isComplete } from "~/lib/completeness";
import { loadEditorContext } from "~/lib/editor.server";
import {
  addReportAction,
  saveExpenseFromForm,
} from "~/lib/expense-save.server";
import { duplicateLabel, findDuplicates } from "~/lib/duplicates";
import type { DuplicateMatch, DuplicateReason } from "~/lib/duplicates";
import { escapeHtml } from "~/lib/escape";
import { normalizeAmount, todayDate } from "~/lib/format";
import {
  MILEAGE_TYPE_LABELS,
  MILEAGE_TYPES,
  mileageAmount,
  mileageRateFor,
  mileageRateLabel,
  type MileageRateEntry,
} from "~/lib/mileage-rates";
import {
  deleteExpense,
  readExpense,
  readNeighborIds,
} from "~/lib/store.server";
import type {
  Expense,
  Location,
  MileageExpense,
  MileageType,
  ReceiptExpense,
  RouteGeometry,
} from "~/lib/types";
import { geocodedLocations } from "~/lib/types";
import { usePasteImage } from "~/lib/use-paste-image";
import { formString, unknownIntent } from "~/lib/validation";
import type { Route } from "./+types/expense.$id";

/**
 * Files carried from the home page (paste/upload) that are being uploaded as
 * editor drafts. Module scope so the guard survives StrictMode's dev
 * double-mount — without it a carried file would be uploaded and OCR'd
 * twice, orphaning the first draft blob.
 */
const draftUploadsInFlight = new WeakSet<File>();

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const expense = await readExpense(params.id, user.accountId);
  if (!expense) throw new Response("Not found", { status: 404 });
  // Editor context (reports, categories, merchants, home, rate) and the
  // prev/next neighbours for the ← → arrows — two targeted queries instead
  // of loading every expense.
  const [nav, context] = await Promise.all([
    readNeighborIds(user.accountId, expense),
    loadEditorContext(user.accountId, expense),
  ]);
  return { mode: "edit" as const, ...context, nav, existing: [] };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData || loaderData.mode !== "edit") return [{ title: "Expense" }];
  const e = loaderData.expense;
  if (e.type === "receipt") {
    const merchant = e.merchant || "New receipt";
    const amount = e.amount ? ` · $${e.amount}` : "";
    return [{ title: `${merchant}${amount} — Expense` }];
  }
  const label = MILEAGE_TYPE_LABELS[e.mileageType];
  const dist = e.distanceMiles ? ` · ${e.distanceMiles} mi` : "";
  return [{ title: `${label}${dist} — Expense` }];
}

export async function action({ request, params }: Route.ActionArgs) {
  const user = await requireUser(request);
  const existing = await readExpense(params.id, user.accountId);
  if (!existing) throw new Response("Not found", { status: 404 });
  const form = await request.formData();
  const intent = formString(form, "intent");

  if (intent === "delete") {
    await deleteExpense(params.id, user.accountId);
    return redirect("/");
  }

  if (intent === "addReport") return addReportAction(form, user.accountId);

  if (intent === "save") {
    const result = await saveExpenseFromForm(form, user.accountId, existing);
    if (result.error)
      return Response.json({ error: result.error }, { status: 400 });
    return redirect("/");
  }

  return unknownIntent();
}

/**
 * Data shape shared by the edit route (/expense/:id) and the create route
 * (/expense/new). Create mode renders the same editors against a skeleton
 * expense — nothing is persisted until Save.
 */
export type EditorData = {
  mode: "create" | "edit";
  expense: Expense;
  existing: Expense[];
  reports: string[];
  categories: string[];
  merchants: string[];
  home: Location;
  /** The IRS mileage-rate master table — the editor resolves the rate from
   * it by (date, type), so changing either recomputes the amount. */
  rates: MileageRateEntry[];
  nav?: { prevId: string | null; nextId: string | null } | null;
};

export default function ExpenseEditor({ loaderData }: Route.ComponentProps) {
  return <Editor data={loaderData} />;
}

/** Shared entry point for both routes; keys by id so navigating to a
 * different expense remounts the editor with fresh field state. Create
 * mode keeps a stable key instead: the route loader builds a fresh shell
 * (new id) on every revalidation, and a changing key would remount the
 * editor mid-edit — wiping the draft form state. */
export function Editor({ data }: { data: EditorData }) {
  const key =
    data.mode === "create" ? `create-${data.expense.type}` : data.expense.id;
  return data.expense.type === "receipt" ? (
    <ReceiptEditor key={key} data={data} />
  ) : (
    <MileageEditor key={key} data={data} />
  );
}

/** Why a matching expense looks like the same entry, in plain words. */
function reasonText(reason: DuplicateReason): string {
  return reason === "same-date-merchant-amount"
    ? "same date, merchant, and amount"
    : "the same trip on the same day";
}

/** Inline warning in the create editors: the draft looks like an existing
 * expense. Informational — it never blocks Save; the Save button turns into
 * "Save anyway" so keeping the entry is deliberate. */
function DuplicateWarning({ matches }: { matches: DuplicateMatch[] }) {
  const first = matches[0]!;
  const extra = matches.length - 1;
  return (
    <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
      <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        This looks like a duplicate of{" "}
        <Link
          to={`/expense/${first.expense.id}`}
          className="font-medium text-blue-700 dark:text-blue-400 hover:underline"
        >
          {duplicateLabel(first.expense)}
        </Link>
        {extra > 0 ? ` (+${extra} more)` : ""} — {reasonText(first.reason)}.
      </span>
    </div>
  );
}

function Shell({
  title,
  nav,
  dimmed,
  onBack,
  children,
}: {
  title: string;
  nav?: { prevId: string | null; nextId: string | null } | null;
  dimmed?: boolean;
  onBack?: () => void;
  children: React.ReactNode;
}) {
  return (
    <PageShell
      title={title}
      dimmed={dimmed}
      onBack={onBack}
      headerRight={
        nav ? (
          <div className="flex items-center gap-1">
            <Link
              to={`/expense/${nav.prevId}`}
              aria-label="Previous expense"
              className={
                nav.prevId
                  ? "inline-flex items-center text-gray-500 dark:text-gray-400 hover:text-ink"
                  : "pointer-events-none text-gray-300 dark:text-gray-500"
              }
            >
              <ChevronLeft aria-hidden="true" className="h-5 w-5" />
            </Link>
            <Link
              to={`/expense/${nav.nextId}`}
              aria-label="Next expense"
              className={
                nav.nextId
                  ? "inline-flex items-center text-gray-500 dark:text-gray-400 hover:text-ink"
                  : "pointer-events-none text-gray-300 dark:text-gray-500"
              }
            >
              <ChevronRight aria-hidden="true" className="h-5 w-5" />
            </Link>
          </div>
        ) : null
      }
    >
      {children}
    </PageShell>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  const opts =
    value && !options.includes(value) ? [value, ...options] : options;
  return (
    <Field label={label}>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    </Field>
  );
}

// --- Receipt editor --------------------------------------------------------

function ReceiptEditor({ data }: { data: EditorData }) {
  const { reports, categories, merchants } = data;
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
    disabled: fetcher.state !== "idle" || drafting,
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
      {duplicateMatches.length > 0 ? (
        <DuplicateWarning matches={duplicateMatches} />
      ) : null}

      <div className="mb-6">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
            Receipt image
          </span>
          <span className="flex gap-1">
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
            {(isNew ? draftPreview : expense.imageFile) ? (
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
      />

      <Field label="Merchant" className="mt-4">
        <Input
          type="text"
          list="merchants"
          value={merchant}
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
      />

      <DescriptionField value={description} onChange={setDescription} />

      <EditorActions
        complete={complete}
        saving={fetcher.state !== "idle" || drafting}
        onCancel={onCancel}
        onSave={() => doSave(onSave)}
        onDelete={isNew ? undefined : () => setConfirmDelete(true)}
        saveLabel={duplicateMatches.length > 0 ? "Save anyway" : undefined}
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

// --- Mileage editor --------------------------------------------------------

function MileageEditor({ data }: { data: EditorData }) {
  const { reports, categories, home, rates } = data;
  const expense = data.expense as MileageExpense;
  const isNew = data.mode === "create";
  const { fetcher, transition, doSave, doDelete, doCancel } = useEditorFlow();

  const [locations, setLocations] = useState<Location[]>(() =>
    initLocations(expense, home),
  );
  // The last geocoded result from /api/route: what the map, the distance,
  // and the saved locations use. Distinct from `locations` (the typed text)
  // so a route response can never rewrite what the user is typing — a slow,
  // stale response would otherwise yank text out from under the cursor.
  const [resolved, setResolved] = useState<Location[]>(() =>
    initLocations(expense, home),
  );
  const [distanceMiles, setDistanceMiles] = useState(expense.distanceMiles);
  const [amount, setAmount] = useState(expense.amount);
  const [date, setDate] = useState(expense.date);
  const [mileageType, setMileageType] = useState<MileageType>(
    expense.mileageType,
  );
  const [report, setReport] = useState(expense.report);
  const [category, setCategory] = useState(expense.category);
  const [description, setDescription] = useState(expense.description);
  const [coords, setCoords] = useState<[number, number][]>(() =>
    // Saved driving geometry when present; empty otherwise — the map never
    // draws a line until real directions are computed (or were saved).
    expense.route.coords.length >= 2 ? expense.route.coords : [],
  );
  const [returnCoords, setReturnCoords] = useState<[number, number][]>(() =>
    expense.route.coords.length >= 2 ? expense.route.returnCoords : [],
  );
  const [approximate, setApproximate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [computing, setComputing] = useState(false);
  // Per-field geocoding errors, aligned with `locations` (null = no error).
  const [addressErrors, setAddressErrors] = useState<(string | null)[]>([]);
  // Route-level error: set when the /api/route call itself fails (HTTP
  // error, network down) — cleared on the next successful geocode.
  const [routeError, setRouteError] = useState<string | null>(null);
  // Indexes of fields currently being geocoded (in-flight blur geocodes and
  // the save-time flush) — drives the per-field spinner.
  const [geocodingFields, setGeocodingFields] = useState<number[]>([]);
  const manualAmount = useRef(false);
  // The IRS rate for the trip's (date, type) — it changes the moment either
  // does, so the footer rate and the recomputed amount stay in sync.
  const rate = useMemo(
    () => mileageRateFor(rates, date, mileageType),
    [rates, date, mileageType],
  );

  /** Changing the type picks a new IRS rate: recompute the amount from the
   * current distance at the new rate (type change → new rate → new amount).
   * Marks the amount auto-computed again so a later route recompute may
   * overwrite it. */
  function changeMileageType(t: MileageType) {
    setMileageType(t);
    manualAmount.current = false;
    setAmount(mileageAmount(distanceMiles, mileageRateFor(rates, date, t)));
  }

  /** Changing the date can move the trip into a different IRS period with a
   * different rate — recompute the amount, same as a type change. */
  function changeDate(d: string) {
    setDate(d);
    manualAmount.current = false;
    setAmount(
      mileageAmount(distanceMiles, mileageRateFor(rates, d, mileageType)),
    );
  }

  // Monotonic id for route requests: only the latest request may update
  // shared state, so an out-of-order response can't overwrite newer
  // results. Typing bumps it too — any in-flight geocode is stale the
  // moment the addresses change.
  const requestSeq = useRef(0);
  // The latest computed route geometry — saved with the expense so the map
  // shows the driving route everywhere (list thumbnails, editor on open),
  // not just while this session's recompute result is in state.
  const lastRoute = useRef<RouteGeometry | null>(null);

  // Legacy expenses (created before routes were persisted) load with no
  // geometry — compute it once on open so the driving route appears. Until
  // it resolves, the map shows the stops unconnected (never a guessed
  // point-to-point line). New expenses start empty (nothing to geocode yet)
  // and compute on the first blur. Distance and amount are left as saved;
  // they refresh on the next explicit recompute.
  useEffect(() => {
    if (expense.route.coords.length >= 2) return;
    const geo = geocodedLocations(locations);
    if (geo.length < 2) return;
    let cancelled = false;
    void (async () => {
      const result = await computeRoute(locations, rate);
      if (!result || cancelled) return;
      lastRoute.current = {
        coords: result.coords,
        returnCoords: result.returnCoords ?? [],
      };
      setCoords(result.coords);
      setReturnCoords(result.returnCoords ?? []);
    })();
    return () => {
      cancelled = true;
    };
    // Run once per editor open (the component is keyed by expense id).
  }, []);

  /** Geocode the addresses and compute the route + amount via /api/route.
   * Pure — no state writes — so callers decide what to apply. */
  async function computeRoute(
    locations: Location[],
    rate: string,
  ): Promise<{
    locations: Location[];
    distanceMiles: string;
    amount: string;
    coords: [number, number][];
    returnCoords: [number, number][];
    approximate: boolean;
  } | null> {
    if (!locations.some((l) => l.address.trim())) {
      // Everything is empty — there is no trip to compute. Return a blank
      // result so callers reset the map and distance to nothing instead of
      // leaving a stale route on screen.
      return {
        locations,
        distanceMiles: "",
        amount: "",
        coords: [],
        returnCoords: [],
        approximate: false,
      };
    }
    setComputing(true);
    try {
      const res = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locations, rate }),
      });
      if (!res.ok) return null;
      return (await res.json()) as {
        locations: Location[];
        distanceMiles: string;
        amount: string;
        coords: [number, number][];
        returnCoords: [number, number][];
        approximate: boolean;
      };
    } catch {
      return null;
    } finally {
      setComputing(false);
    }
  }

  function updateLocation(i: number, address: string) {
    manualAmount.current = false;
    // Any in-flight geocode is stale the moment the text changes.
    requestSeq.current += 1;
    setLocations((prev) =>
      prev.map((l, idx) =>
        idx === i ? { ...l, address, lat: null, lng: null } : l,
      ),
    );
    // Editing clears the field's geocoding error (it'll be retried on blur)
    // and stops its in-flight spinner.
    setAddressErrors((prev) =>
      prev.map((err, idx) => (idx === i ? null : err)),
    );
    setGeocodingFields((prev) => prev.filter((x) => x !== i));
  }

  /** Focus leaving a location field recomputes the trip: an address that
   * geocodes successfully updates the map; a failed geocode shows an error
   * under the field and keeps the typed text; an emptied field that was
   * part of the route drops out (the server ignores blank addresses) and
   * the map, distance, and amount recompute without it. The map never
   * changes while typing. */
  async function commitLocation(i: number) {
    const address = locations[i]?.address ?? "";
    // A field that was never filled (or already emptied and committed)
    // blurs without changing the trip — no recompute. Only a field with
    // typed content, or one that was part of the committed route and is
    // now being emptied, triggers a recompute.
    const wasGeocoded =
      (resolved[i]?.address.trim() ?? "") !== "" || resolved[i]?.lat !== null;
    if (!address.trim() && !wasGeocoded) return;
    setGeocodingFields((prev) => (prev.includes(i) ? prev : [...prev, i]));
    try {
      const seq = ++requestSeq.current;
      const result = await computeRoute(locations, rate);
      // A stale result (seq already advanced by a newer blur/edit) is
      // silently dropped — a newer request is in flight.
      if (requestSeq.current !== seq) return;
      if (!result) {
        setRouteError(
          "Route unavailable. Check your connection and try again.",
        );
        setDistanceMiles("");
        setAmount("");
        return;
      }
      setRouteError(null);
      const r = result.locations[i];
      // A non-empty field that failed to geocode is an error — tell the
      // user, never guess an address. An emptied field is expected to come
      // back without coordinates (it is excluded from the route).
      if (address.trim() && (!r || r.lat === null || r.lng === null)) {
        setAddressErrors((prev) => {
          const next = [...prev];
          next[i] =
            "Couldn't find that address. Try a more complete address with city and state.";
          return next;
        });
        return;
      }
      setAddressErrors((prev) =>
        prev.map((err, idx) => (idx === i ? null : err)),
      );
      setResolved(result.locations);
      setCoords(result.coords);
      setReturnCoords(result.returnCoords ?? []);
      lastRoute.current = {
        coords: result.coords,
        returnCoords: result.returnCoords ?? [],
      };
      setDistanceMiles(result.distanceMiles);
      if (!manualAmount.current) setAmount(result.amount);
      setApproximate(result.approximate);
      setLocations((prev) => prev.map((l, idx) => (idx === i ? r : l)));
    } finally {
      setGeocodingFields((prev) => prev.filter((x) => x !== i));
    }
  }

  function addLocation() {
    requestSeq.current += 1;
    setLocations((prev) => [...prev, { address: "", lat: null, lng: null }]);
    setResolved((prev) => [...prev, { address: "", lat: null, lng: null }]);
    setAddressErrors((prev) => [...prev, null]);
  }

  function removeLocation(i: number) {
    manualAmount.current = false;
    requestSeq.current += 1;
    setLocations((prev) => prev.filter((_, idx) => idx !== i));
    setResolved((prev) => prev.filter((_, idx) => idx !== i));
    setAddressErrors((prev) => prev.filter((_, idx) => idx !== i));
  }

  const complete = useMemo(
    () =>
      isComplete({
        ...expense,
        date,
        report,
        amount,
        locations,
      } as MileageExpense),
    [expense, date, report, amount, locations],
  );

  // Create mode: does this trip look like one that already exists?
  const duplicateMatches = useMemo(
    () =>
      isNew
        ? findDuplicates(
            { ...expense, date, locations, distanceMiles },
            data.existing,
          )
        : [],
    [isNew, expense, date, locations, distanceMiles, data.existing],
  );

  const savingRef = useRef(false);

  async function onSave() {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      // Flush any address typed but never geocoded (Save without blurring
      // the field) so the saved expense keeps its route, distance, and
      // amount; otherwise the geocoded result is already in `resolved`.
      const needsGeocode = locations.some(
        (l) => l.address.trim() !== "" && (l.lat === null || l.lng === null),
      );
      let saveLocations = locations.map((l, i) => {
        const r = resolved[i];
        return r && r.address === l.address ? r : l;
      });
      let saveDistance = distanceMiles;
      let saveAmount = amount;
      if (needsGeocode) {
        // Show the per-field spinner on every address the flush will geocode.
        const toGeocode = locations
          .map((l, i) =>
            l.address.trim() !== "" && (l.lat === null || l.lng === null)
              ? i
              : null,
          )
          .filter((i): i is number => i !== null);
        setGeocodingFields((prev) => [...new Set([...prev, ...toGeocode])]);
        try {
          const seq = ++requestSeq.current;
          const result = await computeRoute(locations, rate);
          if (result && requestSeq.current === seq) {
            // The flush's locations are the canonical geocoded forms (they
            // differ from what was typed), so match on coordinates, not text.
            saveLocations = locations.map((l, i) => {
              const r = result.locations[i];
              return r && r.lat !== null && r.lng !== null ? r : l;
            });
            saveDistance = result.distanceMiles;
            lastRoute.current = {
              coords: result.coords,
              returnCoords: result.returnCoords ?? [],
            };
            if (!manualAmount.current) saveAmount = result.amount;
          }
        } finally {
          setGeocodingFields((prev) =>
            prev.filter((x) => !toGeocode.includes(x)),
          );
        }
      }
      const form = new FormData();
      form.set("intent", "save");
      if (isNew) form.set("type", "mileage");
      form.set("date", date);
      form.set("mileageType", mileageType);
      form.set("amount", saveAmount);
      form.set("report", report);
      form.set("category", category);
      form.set("description", description);
      form.set("distanceMiles", saveDistance);
      form.set("locations", JSON.stringify(saveLocations));
      form.set(
        "route",
        lastRoute.current ? JSON.stringify(lastRoute.current) : "",
      );
      // Submit through the shared flow so the "Saving…" overlay covers the
      // actual request + redirect (the geocode flush above shows the map's
      // computing spinner).
      doSave(() => void fetcher.submit(form, { method: "post" }));
    } finally {
      savingRef.current = false;
    }
  }

  function onDelete() {
    const form = new FormData();
    form.set("intent", "delete");
    void fetcher.submit(form, { method: "post" });
  }

  const error = fetcherError(fetcher.data);
  useFormKeys({
    onSave: () => void onSave(),
    onCancel: doCancel,
    disabled: fetcher.state !== "idle",
    blocked: confirmDelete,
  });

  // The map shows the geocoded route (`resolved`), not the raw typed text —
  // it only changes when an address field loses focus and its address
  // geocodes successfully, never while typing. The tooltip shows the stop's
  // role + its street-and-city form (no state/country), escaped because
  // Leaflet renders tooltip content as HTML.
  const stops = geocodedLocations(resolved).map((l, i) => {
    const label = i === 0 ? "Start / end" : `Stop ${i}`;
    return {
      lat: l.lat,
      lng: l.lng,
      label,
      // Bubble label on the map: S for the start/end, 1/2/… for the stops.
      number: i === 0 ? "S" : String(i),
      tooltip: `${escapeHtml(label)} — ${escapeHtml(shortAddress(l.address))}`,
    };
  });

  return (
    <Shell title="Mileage expense" nav={data.nav} dimmed={!!transition}>
      <ErrorBanner error={error} />
      {duplicateMatches.length > 0 ? (
        <DuplicateWarning matches={duplicateMatches} />
      ) : null}

      <div className="relative mb-6 overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700">
        <MapView
          coords={coords}
          returnCoords={returnCoords}
          stops={stops}
          height={260}
          interactive
          ariaLabel={`Driving route map with ${stops.length} stops — ${distanceMiles ? `${distanceMiles} miles` : "distance not yet computed"}`}
        />
        {computing ? (
          // Geocoding + OSRM can take a couple of seconds — a pill centered
          // over the map says a recompute is in flight instead of leaving
          // the stale route on screen with no feedback.
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span
              role="status"
              className="flex items-center gap-2 rounded-full bg-white/95 px-3.5 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-lg"
            >
              <Loader2
                aria-hidden="true"
                className="h-4 w-4 animate-spin text-blue-600 dark:text-blue-400"
              />
              Calculating route…
            </span>
          </div>
        ) : null}
        {routeError ? (
          <div className="flex items-center gap-2 border-t border-gray-100 dark:border-gray-800 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-400">
            <AlertTriangle aria-hidden="true" className="h-4 w-4" />
            {routeError}
          </div>
        ) : (
          <div className="flex items-center justify-between border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 px-3 py-2 text-sm">
            <span className="flex items-center gap-2 text-gray-600 dark:text-gray-300">
              {computing ? (
                <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              ) : (
                <MapPinned aria-hidden="true" className="h-4 w-4" />
              )}
              {distanceMiles ? `${distanceMiles} mi` : "—"}
              {approximate ? (
                <span className="text-xs text-amber-600 dark:text-amber-400">
                  (approx.)
                </span>
              ) : null}
            </span>
            <span className="text-gray-500 dark:text-gray-400">
              {rate ? (
                <>{mileageRateLabel(mileageType, rate)}</>
              ) : (
                "No rate for this date/type"
              )}
            </span>
          </div>
        )}
      </div>

      <DateAmountFields
        date={date}
        onDate={changeDate}
        type={mileageType}
        onType={changeMileageType}
        amount={amount}
        onAmount={setAmount}
        onManualAmount={() => {
          manualAmount.current = true;
        }}
      />

      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
            Locations
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={addLocation}>
            <Plus aria-hidden="true" className="h-4 w-4" /> Add stop
          </Button>
        </div>
        <ol className="flex flex-col gap-2">
          {locations.map((l, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="w-20 shrink-0 pt-2 text-xs font-medium text-gray-500 dark:text-gray-400">
                {i === 0 ? "Start / end" : `Stop ${i}`}
              </span>
              <div className="min-w-0 flex-1">
                <div className="relative">
                  <Input
                    type="text"
                    placeholder="Address"
                    invalid={!!addressErrors[i]}
                    aria-describedby={
                      addressErrors[i] ? `address-error-${i}` : undefined
                    }
                    className={`w-full ${
                      geocodingFields.includes(i) ? "pr-9" : ""
                    }`}
                    value={l.address}
                    onChange={(e) => updateLocation(i, e.target.value)}
                    onBlur={() => commitLocation(i)}
                  />
                  {geocodingFields.includes(i) ? (
                    <Loader2
                      aria-label="Geocoding address"
                      className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-gray-500 dark:text-gray-400"
                    />
                  ) : null}
                </div>
                {addressErrors[i] ? (
                  <p
                    id={`address-error-${i}`}
                    className="mt-1 text-xs text-red-600 dark:text-red-400"
                  >
                    {addressErrors[i]}
                  </p>
                ) : null}
              </div>
              {/* The start/end and the first stop are required — only extra
                  stops can be removed. */}
              {i >= 2 ? (
                <button
                  type="button"
                  className="mt-2 rounded p-1 text-gray-500 dark:text-gray-400 hover:text-red-600 dark:text-red-400"
                  onClick={() => removeLocation(i)}
                  aria-label="Remove stop"
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                </button>
              ) : null}
            </li>
          ))}
        </ol>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          The route runs Start / end → stops → back to Start / end. Distance
          updates automatically.
        </p>
      </div>

      <ReportCategoryFields
        report={report}
        onReport={setReport}
        reports={reports}
        category={category}
        onCategory={setCategory}
        categories={categories}
      />

      <DescriptionField value={description} onChange={setDescription} />

      <EditorActions
        complete={complete}
        saving={fetcher.state !== "idle"}
        onCancel={doCancel}
        onSave={() => void onSave()}
        onDelete={isNew ? undefined : () => setConfirmDelete(true)}
        saveLabel={duplicateMatches.length > 0 ? "Save anyway" : undefined}
      />
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

function initLocations(expense: MileageExpense, home: Location): Location[] {
  const saved = expense.locations.map((l) => ({ ...l }));
  // A mileage expense always has a start/end and a first stop — pad trips
  // that predate that rule (or start fresh from the account's start
  // location).
  if (saved.length === 1) {
    return [...saved, { address: "", lat: null, lng: null }];
  }
  if (saved.length > 1) return saved;
  const first: Location = home.address
    ? { ...home }
    : { address: "", lat: null, lng: null };
  return [first, { address: "", lat: null, lng: null }];
}

/** "Street, city" form of a canonical address — the first two comma parts,
 * used for map tooltips so the state/country don't crowd the popup. Falls
 * back to the full address when it has fewer than two parts. */
function shortAddress(address: string): string {
  const parts = address
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.slice(0, 2).join(", ") || address;
}

// --- Shared editor chrome --------------------------------------------------

/**
 * Shared editor flow: the save/cancel/delete transition state and the
 * fetcher, plus clearing the transition overlay when a submission finishes
 * without navigating (validation error). `doSave`/`doDelete` set the overlay
 * and then run the caller's submit; `doCancel` navigates home.
 */
function useEditorFlow() {
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [transition, setTransition] = useState<
    null | "save" | "cancel" | "delete"
  >(null);

  const doSave = (submit: () => void) => {
    setTransition("save");
    submit();
  };
  const doDelete = (submit: () => void) => {
    setTransition("delete");
    submit();
  };
  const doCancel = () => {
    setTransition("cancel");
    void navigate("/");
  };

  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      (transition === "save" || transition === "delete")
    )
      setTransition(null);
  }, [fetcher.state, transition]);

  return { fetcher, transition, doSave, doDelete, doCancel };
}

/** Inline validation error shown at the top of an editor; renders nothing
 * when there is no error. */
function ErrorBanner({ error }: { error: string }) {
  if (!error) return null;
  return (
    <p
      role="alert"
      className="mb-4 rounded-lg bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-400"
    >
      {error}
    </p>
  );
}

/**
 * Prominent in-progress indicator for a receipt draft: a spinner, the stage
 * currently running (PDF rasterization or OCR/extraction), and an
 * indeterminate progress bar so the wait reads as active work.
 */
function DraftProgress({ stage }: { stage: "convert" | "ocr" | null }) {
  const converting = stage === "convert";
  return (
    <div
      role="status"
      className="mt-2 rounded-xl border border-blue-100 dark:border-gray-700 bg-blue-50/60 dark:bg-blue-900/60 px-4 py-3"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200">
        <Loader2
          aria-hidden="true"
          className="h-4 w-4 shrink-0 animate-spin text-blue-600 dark:text-blue-400"
        />
        <span>{converting ? "Converting PDF…" : "Reading receipt…"}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-blue-100 dark:bg-gray-700">
        <div className="h-full w-1/3 animate-[progress-slide_1.2s_ease-in-out_infinite] rounded-full bg-blue-500" />
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {converting
          ? "Rasterizing the PDF so it can be displayed and read."
          : "Extracting the merchant, amount, and category."}
      </p>
    </div>
  );
}

/** The Date + Type + Amount field row shared by both editors (amount
 * normalizes on blur; mileage marks manual edits so route recomputation
 * won't overwrite them). Mileage renders a Type select between Date and
 * Amount — changing it (or the date) picks a new IRS rate and recomputes
 * the amount. Receipts pass no type and keep the two-column layout. */
function DateAmountFields({
  date,
  onDate,
  type,
  onType,
  amount,
  onAmount,
  amountRef,
  onManualAmount,
}: {
  date: string;
  onDate: (v: string) => void;
  /** Mileage: the IRS trip type; the select only renders when present. */
  type?: MileageType;
  onType?: (t: MileageType) => void;
  amount: string;
  onAmount: (v: string) => void;
  /** Receipt: the field to autofocus when the editor opens. */
  amountRef?: React.RefObject<HTMLInputElement | null>;
  /** Mileage: runs before each keystroke (marks the amount as hand-edited). */
  onManualAmount?: () => void;
}) {
  const hasType = type !== undefined && onType !== undefined;
  return (
    <div className={`grid gap-4 ${hasType ? "grid-cols-3" : "grid-cols-2"}`}>
      <Field label="Date">
        <Input
          type="date"
          tabIndex={-1}
          max={todayDate()}
          value={date}
          onChange={(e) => onDate(e.target.value)}
        />
      </Field>
      {hasType ? (
        <Field label="Type">
          <Select
            value={type}
            onChange={(e) => onType(e.target.value as MileageType)}
          >
            {MILEAGE_TYPES.map((t) => (
              <option key={t} value={t}>
                {MILEAGE_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field label="Amount">
        <Input
          type="number"
          step="0.01"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          ref={amountRef}
          onClick={(e) => e.currentTarget.select()}
          onChange={(e) => {
            onManualAmount?.();
            onAmount(e.target.value);
          }}
          onBlur={(e) => onAmount(normalizeAmount(e.target.value))}
        />
      </Field>
    </div>
  );
}

/** Sentinel value of the Report select option that opens the new-report
 * input. Can never collide with a real name (report names are trimmed,
 * non-empty). */
const NEW_REPORT = "__new__";

/** The Report picker: a dropdown of open reports plus a "+ New report…"
 * option that swaps the select for an inline name input with explicit
 * Create/Cancel. Selecting the dropdown never creates anything — creation
 * requires a name and an explicit Create click (or Enter), so a stray tap
 * or scroll through the list can't mint a report by accident. Escape (or
 * Cancel) closes the input untouched. */
function ReportField({
  value,
  onChange,
  reports,
}: {
  value: string;
  onChange: (v: string) => void;
  reports: string[];
}) {
  const fetcher = useFetcher<{ ok: boolean; name?: string; error?: string }>();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A created report becomes the selection and closes the input; a rejected
  // add (empty or duplicate name) keeps the input open with its error.
  useEffect(() => {
    const { data } = fetcher;
    if (!data) return;
    if (data.ok && data.name) {
      onChange(data.name);
      setCreating(false);
      setDraft("");
      setError(null);
    } else if (data.error) {
      setError(data.error);
    }
  }, [fetcher.data, onChange]);

  // Focus the name input as soon as the inline form opens.
  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const submit = () => {
    const name = draft.trim();
    if (!name) return;
    void fetcher.submit({ intent: "addReport", name }, { method: "post" });
  };
  const cancel = () => {
    setCreating(false);
    setDraft("");
    setError(null);
  };

  if (creating) {
    return (
      <Field label="Report">
        <div className="flex items-center gap-2" data-report-create>
          <Input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                cancel();
              }
            }}
            placeholder="New report name"
            aria-invalid={error ? true : undefined}
            invalid={!!error}
            className="min-w-0 flex-1"
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={!draft.trim()}
            onClick={submit}
          >
            <Plus aria-hidden="true" className="h-4 w-4" /> Create
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        </div>
        {error ? (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>
        ) : null}
      </Field>
    );
  }

  const opts =
    value && !reports.includes(value) ? [value, ...reports] : reports;
  return (
    <Field label="Report">
      <Select
        value={value}
        onChange={(e) => {
          if (e.target.value === NEW_REPORT) {
            setCreating(true);
            setError(null);
          } else {
            onChange(e.target.value);
          }
        }}
      >
        <option value="">—</option>
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        <option value={NEW_REPORT}>+ New report…</option>
      </Select>
    </Field>
  );
}

/** The Report + Category picker pair shared by both editors. */
function ReportCategoryFields({
  report,
  onReport,
  reports,
  category,
  onCategory,
  categories,
}: {
  report: string;
  onReport: (v: string) => void;
  reports: string[];
  category: string;
  onCategory: (v: string) => void;
  categories: string[];
}) {
  return (
    <div className="mt-4 grid grid-cols-2 gap-4 items-start">
      <ReportField value={report} onChange={onReport} reports={reports} />
      <SelectField
        label="Category"
        value={category}
        onChange={onCategory}
        options={categories}
      />
    </div>
  );
}

/** The Description textarea shared by both editors. */
function DescriptionField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field label="Description" className="mt-4">
      <Textarea
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

function EditorActions({
  complete,
  saving,
  onCancel,
  onSave,
  onDelete,
  saveLabel,
}: {
  complete: boolean;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
  onDelete?: () => void;
  saveLabel?: string;
}) {
  return (
    <div className="mt-8 flex items-center justify-between border-t border-gray-200 dark:border-gray-700 pt-4">
      {onDelete ? (
        <Button
          type="button"
          variant="danger"
          tabIndex={-1}
          onClick={onDelete}
          disabled={saving}
        >
          <Trash2 aria-hidden="true" className="h-4 w-4" /> Delete
        </Button>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-2">
        {!complete ? (
          <span className="text-sm text-amber-700 dark:text-amber-400">
            Incomplete
          </span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          tabIndex={-1}
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button type="button" onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : (saveLabel ?? "Save")}
        </Button>
      </div>
    </div>
  );
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  // Move focus into the lightbox and restore on close.
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        previousFocus.current?.focus();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Receipt image viewer"
      className="fixed inset-0 z-50 flex flex-col bg-black/85"
      onClick={onClose}
    >
      <div className="flex justify-end p-3">
        <button
          ref={closeRef}
          className="rounded-lg p-1 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          onClick={(e) => {
            e.stopPropagation();
            previousFocus.current?.focus();
            onClose();
          }}
          aria-label="Close image viewer"
        >
          <X aria-hidden="true" className="h-7 w-7" />
        </button>
      </div>
      {/* Scrollable area: image fits width, natural height -> scroll if taller. */}
      <div
        className="min-h-0 flex-1 overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={src}
          alt="Receipt"
          className="mx-auto block h-auto max-w-full"
        />
      </div>
    </div>
  );
}

function fetcherError(data: unknown): string {
  if (data && typeof data === "object" && "error" in data) {
    const e = (data as { error: unknown }).error;
    return typeof e === "string" ? e : "";
  }
  return "";
}

/**
 * Form-wide keyboard shortcuts: Enter saves, Escape cancels.
 * Skipped while an overlay (lightbox/confirm) is open. Enter is ignored in
 * textareas (newlines), on buttons (they submit themselves), and in inputs
 * backed by a datalist (merchant autocomplete picks the suggestion).
 * Drop-downs (selects) DO submit on Enter.
 */
function useFormKeys(opts: {
  onSave: () => void;
  onCancel: () => void;
  disabled: boolean;
  blocked: boolean;
}) {
  const { onSave, onCancel, disabled, blocked } = opts;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (blocked) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      // The inline new-report form (input + buttons) handles Enter/Escape
      // itself — the editor shortcuts must not hijack it (Escape would
      // cancel the whole editor).
      if (target?.closest?.("[data-report-create]")) return;
      // Inputs with a <datalist> (e.g. merchant autocomplete): Enter picks the
      // suggestion, so let the browser handle it and don't submit.
      const hasList = !!target?.getAttribute?.("list");
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        // Cmd/Ctrl+Enter always submits, even in textareas / autocomplete / dropdowns.
        e.preventDefault();
        if (!disabled) onSave();
      } else if (
        e.key === "Enter" &&
        tag !== "TEXTAREA" &&
        tag !== "BUTTON" &&
        !hasList
      ) {
        e.preventDefault();
        if (!disabled) onSave();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onSave, onCancel, disabled, blocked]);
}

/** Brief visual feedback while a save/cancel navigation is in flight. */
function TransitionOverlay({ kind }: { kind: "save" | "cancel" | "delete" }) {
  return (
    <div
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center"
      role="status"
      aria-live="assertive"
    >
      <div className="flex flex-col items-center gap-2 rounded-xl bg-white/90 px-6 py-4 shadow-lg text-gray-600 dark:text-gray-300">
        <Loader2 aria-hidden="true" className="h-7 w-7 animate-spin" />
        <span className="text-sm font-medium">
          {kind === "save"
            ? "Saving…"
            : kind === "delete"
              ? "Deleting…"
              : "Closing…"}
        </span>
      </div>
    </div>
  );
}
