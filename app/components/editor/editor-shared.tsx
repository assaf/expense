import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Lock,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Link, useFetcher, useNavigate } from "react-router";
import { useNameAdd } from "~/components/AddNameForm";
import { PageShell, type DropTarget } from "~/components/PageShell";
import { Alert } from "~/components/ui/Alert";
import { Button } from "~/components/ui/Button";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Field } from "~/components/ui/Field";
import { DatePicker } from "~/components/ui/DatePicker";
import { Input } from "~/components/ui/Input";
import { Select } from "~/components/ui/Select";
import { Textarea } from "~/components/ui/Textarea";
import { duplicateLabel } from "~/lib/duplicates";
import type { DuplicateMatch, DuplicateReason } from "~/lib/duplicates";
import { normalizeAmount } from "~/lib/format";
import {
  MILEAGE_TYPE_LABELS,
  MILEAGE_TYPES,
  type MileageRateEntry,
} from "~/lib/mileage-rates";
import type { Expense, Location, MileageType } from "~/lib/types";

/**
 * Data shape shared by the edit route (/expense/:id) and the create route
 * (/expense/new). Create mode renders the same editors against a skeleton
 * expense; nothing is persisted until Save.
 */
export type EditorData = {
  mode: "create" | "edit";
  expense: Expense;
  existing: Expense[];
  reports: string[];
  categories: string[];
  merchants: string[];
  home: Location;
  /** The IRS mileage-rate master table. The editor resolves the rate from
   * it by (date, type), so changing either recomputes the amount. */
  rates: MileageRateEntry[];
  nav?: { prevId: string | null; nextId: string | null } | null;
  /** True when the expense's report is closed; all fields become read-only. */
  reportClosed: boolean;
};

/** Why a matching expense looks like the same entry, in plain words. */
function reasonText(reason: DuplicateReason): string {
  return reason === "same-date-merchant-amount"
    ? "same date, merchant, and amount"
    : "the same trip on the same day";
}

/** Inline warning in the create editors: the draft looks like an existing
 * expense. Informational only, it never blocks Save; the Save button turns
 * "Save anyway" so keeping the entry is deliberate. */
export function DuplicateWarning({ matches }: { matches: DuplicateMatch[] }) {
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

export function Shell({
  title,
  nav,
  dimmed,
  onBack,
  drop,
  children,
}: {
  title: string;
  nav?: { prevId: string | null; nextId: string | null } | null;
  dimmed?: boolean;
  onBack?: () => void;
  /** Drag-and-drop target handlers + outline (receipt editor). */
  drop?: DropTarget;
  children: React.ReactNode;
}) {
  return (
    <PageShell
      title={title}
      dimmed={dimmed}
      onBack={onBack}
      drop={drop}
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

/** A labeled single select with an em-dash empty option; a current value
 * missing from the options is prepended so it still shows. */
export function SelectField({
  label,
  value,
  onChange,
  options,
  disabled,
  className,
  selectClassName,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  disabled?: boolean;
  /** Extra classes for the Field wrapper (e.g. grid sizing). */
  className?: string;
  /** Extra classes for the underlying Select (e.g. h-9). */
  selectClassName?: string;
}) {
  const opts =
    value && !options.includes(value) ? [value, ...options] : options;
  return (
    <Field label={label} className={className}>
      <Select
        value={value}
        disabled={disabled}
        className={selectClassName}
        onChange={(e) => onChange(e.target.value)}
      >
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

/**
 * Shared editor flow: the save/cancel/delete transition state and the
 * fetcher, plus clearing the transition overlay when a submission finishes
 * without navigating (validation error). `doSave`/`doDelete` set the overlay
 * and then run the caller's submit; `doCancel` navigates home.
 */
export function useEditorFlow() {
  const fetcher = useFetcher<{ error?: string }>();
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
export function ErrorBanner({ error }: { error: string }) {
  if (!error) return null;
  return <Alert className="mb-4 text-red-700 dark:text-red-400">{error}</Alert>;
}

/**
 * Prominent in-progress indicator for a receipt draft: a spinner, the stage
 * currently running (PDF rasterization or OCR/extraction), and an
 * indeterminate progress bar so the wait reads as active work.
 */
export function DraftProgress({ stage }: { stage: "convert" | "ocr" | null }) {
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
 * Amount; changing it (or the date) picks a new IRS rate and recomputes
 * the amount. Receipts pass no type and keep the two-column layout. */
export function DateAmountFields({
  date,
  onDate,
  type,
  onType,
  amount,
  onAmount,
  amountRef,
  onManualAmount,
  disabled,
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
  disabled?: boolean;
}) {
  const hasType = type !== undefined && onType !== undefined;
  return (
    <div className={`grid gap-4 ${hasType ? "grid-cols-3" : "grid-cols-2"}`}>
      <Field label="Date">
        <DatePicker
          value={date}
          disabled={disabled}
          onChange={(v) => onDate(v)}
        />
      </Field>
      {hasType ? (
        <Field label="Type">
          <Select
            value={type}
            disabled={disabled}
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
          disabled={disabled}
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
 * Create/Cancel. Selecting the dropdown never creates anything; creation
 * requires a name and an explicit Create click (or Enter), so a stray tap
 * or scroll through the list can't mint a report by accident. Escape (or
 * Cancel) closes the input untouched. */
function ReportField({
  value,
  onChange,
  reports,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  reports: string[];
  disabled?: boolean;
}) {
  const { draft, updateDraft, error, submit, reset } = useNameAdd({
    intent: "addReport",
    onAdded: (name) => {
      onChange(name);
      setCreating(false);
    },
  });
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the name input as soon as the inline form opens.
  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const cancel = () => {
    setCreating(false);
    reset();
  };

  if (creating) {
    return (
      <Field label="Report">
        <div className="flex items-center gap-2" data-report-create>
          <Input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => updateDraft(e.target.value)}
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
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === NEW_REPORT) {
            setCreating(true);
            reset();
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
        {!disabled ? <option value={NEW_REPORT}>+ New report…</option> : null}
      </Select>
    </Field>
  );
}

/** The Report + Category picker pair shared by both editors. */
export function ReportCategoryFields({
  report,
  onReport,
  reports,
  category,
  onCategory,
  categories,
  disabled,
}: {
  report: string;
  onReport: (v: string) => void;
  reports: string[];
  category: string;
  onCategory: (v: string) => void;
  categories: string[];
  disabled?: boolean;
}) {
  return (
    <div className="mt-4 grid grid-cols-2 gap-4 items-start">
      <ReportField
        value={report}
        onChange={onReport}
        reports={reports}
        disabled={disabled}
      />
      <SelectField
        label="Category"
        value={category}
        onChange={onCategory}
        options={categories}
        disabled={disabled}
      />
    </div>
  );
}

/** The Description textarea shared by both editors. */
export function DescriptionField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <Field label="Description" className="mt-4">
      <Textarea
        rows={3}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

export function EditorActions({
  complete,
  saving,
  onCancel,
  onSave,
  onDelete,
  saveLabel,
  readOnly,
}: {
  complete: boolean;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
  onDelete?: () => void;
  saveLabel?: string;
  readOnly?: boolean;
}) {
  if (readOnly) return null;
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

/** Submit a "delete" intent through a fetcher: the shared delete action
 * of the receipt and mileage editors (the row is deleted server-side, no
 * page navigation). */
export function submitDelete(fetcher: ReturnType<typeof useFetcher>): void {
  const form = new FormData();
  form.set("intent", "delete");
  void fetcher.submit(form, { method: "post" });
}

/** Banner shown when the expense lives in a closed report (read-only). */
export function ClosedReportBanner() {
  return (
    <div className="mb-4 flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-3 py-2 text-sm text-gray-600 dark:text-gray-400">
      <Lock aria-hidden="true" className="h-4 w-4" />
      This expense is in a closed report.
    </div>
  );
}

/** The confirm-delete dialog both editors render after the Delete button
 * asks first. Renders nothing until `open`. */
export function DeleteConfirmDialog({
  open,
  onConfirm,
  onCancel,
  busy,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  if (!open) return null;
  return (
    <ConfirmDialog
      message="Delete this expense? This cannot be undone."
      onConfirm={onConfirm}
      onCancel={onCancel}
      deleting={busy}
    />
  );
}

export function Lightbox({
  src,
  onClose,
}: {
  src: string;
  onClose: () => void;
}) {
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

export function fetcherError(data: unknown): string {
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
export function useFormKeys(opts: {
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
      // itself; the editor shortcuts must not hijack it (Escape would
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
export function TransitionOverlay({
  kind,
}: {
  kind: "save" | "cancel" | "delete";
}) {
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
