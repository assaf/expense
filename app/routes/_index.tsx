import {
  Upload,
  MapPinned,
  ReceiptText,
  Settings,
  Download,
  AlertTriangle,
  Search,
  X,
  BadgeCheck,
  ListChecks,
  Mail,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  data,
  Link,
  useFetcher,
  useNavigate,
  useSearchParams,
} from "react-router";
import {
  FeatureHighlight,
  pickHighlight,
  type HighlightData,
  type HighlightId,
} from "~/components/FeatureHighlight";
import LandingPage from "~/components/LandingPage";
import { Logo } from "~/components/Logo";
import { Button } from "~/components/ui/Button";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Input } from "~/components/ui/Input";
import { EmptyState } from "~/components/ui/EmptyState";
import { isComplete } from "~/lib/completeness";
import { duplicateLabel, groupDuplicateMatches } from "~/lib/duplicates";
import type { DuplicateMatch } from "~/lib/duplicates";
import { imageVersion } from "~/lib/image-version";
import {
  countLabel,
  formatAmount,
  formatDate,
  sortExpenses,
  summarizeByReport,
  todayDate,
} from "~/lib/format";
import { isAuthenticated, requireUser } from "~/lib/auth.server";
import { INBOUND_EMAIL_ADDRESS } from "~/lib/env";
import {
  MILEAGE_TYPE_LABELS,
  currentMileageRates,
  formatRate,
  type MileageRateEntry,
} from "~/lib/mileage-rates";
import { SITE_URL } from "~/lib/seo-content";
import { usePasteImage } from "~/lib/use-paste-image";
import { readAccount } from "~/lib/db/accounts";
import { deleteExpense, readExpenses } from "~/lib/db/expenses";
import { readReports } from "~/lib/db/reports";
import { readMileageRates } from "~/lib/db/seed";
import {
  dismissDuplicatePair,
  readDuplicateDismissals,
} from "~/lib/db/settings";
import type { Expense } from "~/lib/types";
import { formString, unknownIntent } from "~/lib/validation";
import type { Route } from "./+types/_index";

export async function loader({ request }: Route.LoaderArgs) {
  // Anonymous visitors see the landing page; signed-in users see the app.
  if (!(await isAuthenticated(request))) {
    return data({ mode: "landing" as const });
  }
  const user = await requireUser(request);
  const [expenses, dismissed, allReports, rates, account] = await Promise.all([
    readExpenses(user.accountId),
    readDuplicateDismissals(user.accountId),
    readReports(user.accountId),
    readMileageRates(),
    readAccount(user.accountId),
  ]);
  // Closed reports stay off the home page: no summary card, no expenses.
  const closed = new Set(allReports.filter((r) => r.closed).map((r) => r.name));
  const open = expenses.filter((e) => !closed.has(e.report));
  const sorted = sortExpenses(open);
  // Which rows look like each other (both sides of a pair). Matched against
  // ALL expenses — including rows in closed reports — so a re-uploaded
  // receipt still warns when the original was already filed.
  const matchesByExpense = groupDuplicateMatches(expenses, dismissed);
  // The mileage-rate highlight is eligible when the account has rates; the
  // actual rate is computed CLIENT-side from the browser's local today (the
  // server runs UTC and must not guess the user's timezone).
  const reports = [...summarizeByReport(open, { includeUnassigned: true })]
    .map(([name, s]) => ({ name, count: s.count, total: s.total.toFixed(2) }))
    .toSorted((a, b) =>
      a.name === "Unassigned"
        ? 1
        : b.name === "Unassigned"
          ? -1
          : a.name.localeCompare(b.name),
    );
  // The feature highlight that shows at the bottom of the list — picked at
  // random from the ones this account's data can render, so every return
  // visit surfaces something different.
  const highlightData: HighlightData = {
    inboundAddress: INBOUND_EMAIL_ADDRESS,
    mcpUrl: new URL("/mcp", request.url).toString(),
    inviteCode: account?.inviteCode ?? "",
    // The rate is filled in client-side after mount (browser's local today);
    // hasRates decides whether the mileage-rate highlight is eligible.
    mileageRate: "",
    hasRates: rates.length > 0,
  };
  return data(
    {
      mode: "app" as const,
      expenses: sorted.map((e) => toListItem(e, matchesByExpense.get(e.id))),
      rates,
      reports,
      highlight: { id: pickHighlight(highlightData), data: highlightData },
    },
    {
      headers: {
        "Cache-Control": "private, no-cache, no-store, must-revalidate",
        Vary: "Cookie",
      },
    },
  );
}

/**
 * Never cache the home page — it switches between landing (anonymous) and
 * expense list (authenticated) based on the session cookie. Browsers and
 * CDNs must revalidate on every request and segment by cookie so an
 * authenticated user never sees the cached landing page.
 */
export function headers({ loaderHeaders }: Route.HeadersArgs) {
  if (loaderHeaders.has("Cache-Control")) {
    // Already set by the loader (authenticated response) — keep it.
    return { Vary: "Cookie" };
  }
  return {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Vary: "Cookie",
  };
}

/** List-level actions: dismiss a duplicate warning or delete a row.
 * Deleting from the list still goes through the confirm dialog — deletion
 * has no undo, so it always asks first. */
export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  const form = await request.formData();
  const intent = formString(form, "intent");

  if (intent === "dismiss-duplicate") {
    const id = formString(form, "id");
    const otherIds = formString(form, "otherIds")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const otherId of otherIds) {
      await dismissDuplicatePair(user.accountId, id, otherId);
    }
    return null;
  }

  if (intent === "delete") {
    await deleteExpense(formString(form, "id"), user.accountId);
    return null;
  }

  return unknownIntent();
}

function toListItem(e: Expense, matches: DuplicateMatch[] | undefined) {
  return {
    id: e.id,
    type: e.type,
    mileageType: e.type === "mileage" ? e.mileageType : "business",
    date: e.date,
    amount: e.amount,
    category: e.category,
    report: e.report,
    description: e.description,
    complete: isComplete(e),
    reconciled: Boolean(e.reconciledAt),
    imageFile: e.type === "receipt" ? e.imageFile : "",
    updatedAt: e.updatedAt,
    locations: e.type === "mileage" ? e.locations : [],
    distanceMiles: e.type === "mileage" ? e.distanceMiles : "",
    merchant: e.type === "mileage" ? "" : e.merchant,
    duplicates: (matches ?? []).map((m) => ({
      expenseId: m.expense.id,
      reason: m.reason,
      label: duplicateLabel(m.expense),
    })),
  };
}

/** Text fields the search box filters on — the merchant (or "mileage" with
 * the route addresses for mileage rows), description, category, and the
 * amount formatted as "$x.xx" so a query like "$7" matches "$7.50". */
function searchableText(e: ReturnType<typeof toListItem>): string {
  const parts = [
    e.type === "receipt"
      ? e.merchant
      : `${MILEAGE_TYPE_LABELS[e.mileageType]} mileage`,
    e.type === "mileage" ? e.locations.map((l) => l.address).join(" ") : "",
    e.description,
    e.category,
    e.amount ? formatAmount(e.amount) : "",
  ];
  return parts.join(" ").toLowerCase();
}

/** Case-insensitive word filter: every whitespace-separated word in the
 * query must appear somewhere in the row's searchable text; "" matches
 * everything (all rows). */
function matchesSearch(e: ReturnType<typeof toListItem>, query: string) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = searchableText(e);
  return words.every((word) => haystack.includes(word));
}

const OG_IMAGE = `${SITE_URL}/screenshot-og.png`;

export function meta({ loaderData }: Route.MetaArgs) {
  if (loaderData?.mode === "landing") {
    return [
      { title: "Expense: every receipt, ready for tax season" },
      {
        name: "description",
        content:
          "Snap a photo, paste a screenshot, or forward a receipt email. Expense reads the merchant and amount and files each one into IRS Schedule C categories and reports, ready to export for tax season.",
      },
      { tagName: "link", rel: "canonical", href: `${SITE_URL}/` },
      { property: "og:url", content: `${SITE_URL}/` },
      {
        property: "og:title",
        content: "Expense: every receipt, ready for tax season",
      },
      {
        property: "og:description",
        content:
          "Snap a photo or forward a receipt and the merchant, amount, and category are filled in automatically. Organized into Schedule C categories and reports, ready to hand your accountant at tax time.",
      },
      { property: "og:image", content: OG_IMAGE },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      {
        property: "og:image:alt",
        content:
          "The Expense home page: report totals, receipts with thumbnails, and a mileage entry",
      },
      {
        name: "twitter:title",
        content: "Expense: every receipt, ready for tax season",
      },
      {
        name: "twitter:description",
        content:
          "Snap a photo or forward a receipt and the merchant, amount, and category are filled in automatically. Organized into Schedule C categories and reports, ready to hand your accountant at tax time.",
      },
      { name: "twitter:image", content: OG_IMAGE },
      {
        name: "twitter:image:alt",
        content:
          "The Expense home page: report totals, receipts with thumbnails, and a mileage entry",
      },
    ];
  }
  return [{ title: "Expense" }];
}

export default function IndexPage({ loaderData }: Route.ComponentProps) {
  return loaderData.mode === "landing" ? (
    <LandingPage />
  ) : (
    <ExpenseList
      expenses={loaderData.expenses}
      rates={loaderData.rates}
      reports={loaderData.reports}
      highlight={loaderData.highlight}
    />
  );
}

function ExpenseList({
  expenses,
  rates,
  reports,
  highlight,
}: {
  expenses: ReturnType<typeof toListItem>[];
  rates: MileageRateEntry[];
  reports: { name: string; count: number; total: string }[];
  highlight: { id: HighlightId; data: HighlightData };
}) {
  const [selectedReport, setSelectedReport] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [dragOver, setDragOver] = useState(false);
  // "Today" in the browser's own timezone — the server runs UTC and must
  // not guess the user's day, so everything that depends on it (the future
  // badge, the mileage-rate tip) is computed client-side after mount.
  const [today, setToday] = useState<string | null>(null);
  useEffect(() => {
    setToday(todayDate());
  }, []);
  const mileageRate = useMemo(
    () =>
      today
        ? formatRate(currentMileageRates(rates, today)?.byType.business ?? "")
        : "",
    [today, rates],
  );
  // Id of the expense created just now — the create action redirects here
  // with `?new=<id>`; the row stays highlighted for three seconds.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const navigate = useNavigate();
  const fetcher = useFetcher();

  // Consume `?new=<id>` from the create redirect: start the highlight and
  // drop the query param so a reload doesn't re-highlight (replace keeps it
  // out of history).
  useEffect(() => {
    const newId = searchParams.get("new");
    if (!newId) return;
    setHighlightId(newId);
    const next = new URLSearchParams(searchParams);
    next.delete("new");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // Clear the highlight three seconds after it starts.
  useEffect(() => {
    if (!highlightId) return;
    const timer = setTimeout(() => setHighlightId(null), 3000);
    return () => clearTimeout(timer);
  }, [highlightId]);

  // Debounce the search box: wait 200ms after the last keystroke before
  // applying the filter, and collapse a burst of edits into one update
  // (only the final value ever reaches the list).
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(timer);
  }, [query]);

  // Both list filters run client-side: the report chips narrow by report,
  // the search box by text (amount, merchant, description, category).
  const filtered = useMemo(
    () =>
      expenses.filter(
        (e) =>
          (selectedReport === null ||
            (selectedReport === "Unassigned"
              ? e.report === ""
              : e.report === selectedReport)) &&
          matchesSearch(e, debouncedQuery),
      ),
    [expenses, selectedReport, debouncedQuery],
  );

  usePasteImage(uploadImage);

  /** Open the editor without creating anything — the row appears on Save. */
  function createExpense(type: "receipt" | "mileage") {
    void navigate(
      type === "receipt" ? "/expense/new" : "/expense/new?type=mileage",
    );
  }

  /** Carry the pasted/uploaded file into the new editor as its draft image. */
  function uploadImage(file: File) {
    void navigate("/expense/new", { state: { file } });
  }

  /** Dismiss every duplicate warning on a row — "not a duplicate" is a
   * one-click, permanent dismissal for the pair (no confirm needed: it
   * only hides a warning, it never deletes anything). */
  function dismissDuplicate(expenseId: string, otherIds: string[]) {
    const form = new FormData();
    form.set("intent", "dismiss-duplicate");
    form.set("id", expenseId);
    form.set("otherIds", otherIds.join(","));
    void fetcher.submit(form, { method: "post" });
  }

  /** Delete a row from the list — always after the confirm dialog. */
  function removeExpense() {
    if (!confirmDeleteId) return;
    const form = new FormData();
    form.set("intent", "delete");
    form.set("id", confirmDeleteId);
    setConfirmDeleteId(null);
    void fetcher.submit(form, { method: "post" });
  }

  /** Reset both list filters — the report chips and the search box. */
  function clearFilters() {
    setSelectedReport(null);
    setQuery("");
    setDebouncedQuery("");
  }

  /** The file types the drop zone accepts — matches the upload input. */
  function isReceiptFile(file: File): boolean {
    return (
      file.type.startsWith("image/") ||
      file.type === "application/pdf" ||
      /\.pdf$/i.test(file.name)
    );
  }

  // dragenter/dragleave fire for every child element crossed, so track depth
  // instead of toggling on each event — prevents the highlight from flickering.
  function onDragEnter(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  }

  function onDragOver(e: DragEvent<HTMLElement>) {
    // preventDefault is required to turn the drag into a drop target.
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragOver(false);
    }
  }

  function onDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && isReceiptFile(file)) uploadImage(file);
  }

  return (
    <main
      id="main-content"
      className={`mx-auto max-w-4xl px-4 py-8 ${dragOver ? "outline-dashed outline-2 -outline-offset-2 outline-blue-500" : ""}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      aria-label="Expense list — drag a receipt image anywhere to upload"
    >
      <div className="sr-only" role="status" aria-live="polite">
        {dragOver ? "Receipt file detected — drop to upload" : ""}
      </div>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1>
          <Logo link />
        </h1>
        <nav className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link to="/reconcile">
              <ListChecks aria-hidden="true" className="h-4 w-4" /> Reconcile
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to="/export">
              <Download aria-hidden="true" className="h-4 w-4" /> Reports
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to="/emails">
              <Mail aria-hidden="true" className="h-4 w-4" /> Email
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to="/settings">
              <Settings aria-hidden="true" className="h-4 w-4" /> Settings
            </Link>
          </Button>
        </nav>
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-0.5 sm:gap-2">
          <Button onClick={() => createExpense("receipt")}>
            <ReceiptText aria-hidden="true" className="h-4 w-4" /> Add receipt
          </Button>
          <Button onClick={() => createExpense("mileage")} variant="secondary">
            <MapPinned aria-hidden="true" className="h-4 w-4" /> Add mileage
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => fileRef.current?.click()}
          >
            <Upload aria-hidden="true" className="h-4 w-4" /> Upload file
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f) uploadImage(f);
              e.currentTarget.value = "";
            }}
          />
        </div>
        <div className="relative w-full sm:min-w-56 sm:flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500 dark:text-gray-400"
          />
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search amount, merchant, description, or category"
            aria-label="Search expenses"
            className="h-10 w-full pl-9 pr-9 text-sm"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-gray-500 dark:text-gray-400 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-300"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>

      {reports.length > 0 ? (
        <section
          aria-label="Report summaries"
          className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4"
        >
          <h2 className="sr-only">Report summaries</h2>
          {reports.map((r) => {
            const active = selectedReport === r.name;
            return (
              <button
                key={r.name}
                type="button"
                onClick={() => setSelectedReport(active ? null : r.name)}
                aria-pressed={active}
                className={`rounded-xl border p-3 text-left transition-colors ${active ? "border-blue-500 bg-blue-50 dark:bg-blue-900/60 ring-1 ring-blue-500" : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-gray-300 dark:hover:border-gray-600"}`}
              >
                <div className="truncate text-sm font-medium text-gray-700 dark:text-gray-200">
                  {r.name}
                </div>
                <div className="text-lg font-semibold tabular-nums">
                  {formatAmount(r.total)}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {countLabel(r.count)}
                </div>
              </button>
            );
          })}
        </section>
      ) : null}

      {selectedReport !== null || debouncedQuery ? (
        <div className="mb-3 flex items-center justify-between gap-2 text-sm text-gray-600 dark:text-gray-300">
          <span role="status" aria-live="polite">
            {debouncedQuery
              ? `Showing ${filtered.length} of ${expenses.length} expenses`
              : selectedReport === "Unassigned"
                ? "Showing unassigned expenses"
                : `Showing ${selectedReport} expenses`}
          </span>
          <button
            type="button"
            className="text-blue-600 dark:text-blue-400 hover:underline"
            onClick={clearFilters}
          >
            Show all
          </button>
        </div>
      ) : null}

      {expenses.length === 0 ? (
        <EmptyState>
          Nothing here yet. Add your first receipt or log a drive — it takes
          under a minute.
        </EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState className="p-10">
          No expenses match these filters.
        </EmptyState>
      ) : (
        <section aria-label="Expense list">
          <h2 className="sr-only">Expenses</h2>
          <ul className="flex flex-col gap-2">
            {filtered.map((e) => (
              <ExpenseRow
                key={e.id}
                expense={e}
                today={today}
                isNew={e.id === highlightId}
                onDismiss={(otherIds) => dismissDuplicate(e.id, otherIds)}
                onRemove={() => setConfirmDeleteId(e.id)}
              />
            ))}
          </ul>
        </section>
      )}

      <FeatureHighlight
        id={highlight.id}
        data={{ ...highlight.data, mileageRate }}
      />

      {confirmDeleteId ? (
        <ConfirmDialog
          message="Delete this expense? This cannot be undone."
          onConfirm={removeExpense}
          onCancel={() => setConfirmDeleteId(null)}
          deleting={fetcher.state !== "idle"}
        />
      ) : null}
    </main>
  );
}

function ExpenseRow({
  expense,
  today,
  isNew = false,
  onDismiss,
  onRemove,
}: {
  expense: ReturnType<typeof toListItem>;
  /** Browser-local today (null before mount — SSR renders without the
   * badge; the server must not guess the user's timezone). */
  today: string | null;
  isNew?: boolean;
  onDismiss: (otherIds: string[]) => void;
  onRemove: () => void;
}) {
  const to = `/expense/${expense.id}`;
  const rowRef = useRef<HTMLLIElement>(null);
  const dup = expense.duplicates[0];
  const future = Boolean(today && expense.date && expense.date > today);

  // A newly added expense sorts near the top, but the list may have been
  // scrolled — bring the highlighted row into view.
  useEffect(() => {
    if (isNew) {
      rowRef.current?.scrollIntoView({
        block: "nearest",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
    }
  }, [isNew]);

  return (
    <li ref={rowRef}>
      <div
        className={`overflow-hidden rounded-xl border transition-colors ${
          isNew
            ? "border-blue-400 bg-blue-100 dark:bg-blue-900/40 ring-2 ring-blue-400 dark:ring-blue-500"
            : expense.complete
              ? "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
              : "border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950"
        }`}
      >
        <Link
          to={to}
          className="flex items-center gap-4 p-3 transition-colors hover:bg-black/5 dark:hover:bg-white/5"
          aria-label={`${expense.type === "receipt" ? expense.merchant || "No merchant" : MILEAGE_TYPE_LABELS[expense.mileageType]}, ${expense.description ? expense.description + ", " : ""}${formatAmount(expense.amount)}, ${formatDate(expense.date)}${!expense.complete ? ", incomplete" : ""}${expense.reconciled ? ", reconciled" : ""}${future ? ", future" : ""}`}
        >
          <Thumbnail expense={expense} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-medium">
                {expense.type === "receipt"
                  ? expense.merchant || "No merchant"
                  : `${MILEAGE_TYPE_LABELS[expense.mileageType]}${
                      expense.distanceMiles
                        ? ` · ${expense.distanceMiles} mi`
                        : ""
                    }`}
                {expense.description ? (
                  <span className="text-gray-500 dark:text-gray-400">
                    {" "}
                    · {expense.description}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 font-semibold tabular-nums">
                {formatAmount(expense.amount)}
              </span>
            </div>
            <div
              className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-gray-500 dark:text-gray-400"
              aria-hidden="true"
            >
              <span>{formatDate(expense.date)}</span>
              {future ? (
                <span
                  className="rounded-full bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/60 dark:text-blue-400"
                  title="Dated in the future"
                >
                  Future
                </span>
              ) : null}
              {expense.reconciled ? (
                <span
                  className="flex items-center gap-1 rounded-full bg-green-100 dark:bg-green-900/60 px-1.5 py-0.5 text-xs font-medium text-green-700 dark:text-green-400"
                  title="Matched against a credit card statement"
                >
                  <BadgeCheck aria-hidden="true" className="h-3.5 w-3.5" />{" "}
                  Reconciled
                </span>
              ) : null}
              {expense.category ? (
                <span className="rounded bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-xs">
                  {expense.category}
                </span>
              ) : null}
              {expense.report ? <span>{expense.report}</span> : null}
              {!expense.complete ? (
                <span className="font-medium text-amber-700 dark:text-amber-400">
                  Incomplete
                </span>
              ) : null}
            </div>
          </div>
        </Link>
        {dup ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
            <span className="flex items-center gap-1.5 font-medium">
              <AlertTriangle
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0"
              />
              <span>
                Possible duplicate of {dup.label}
                {expense.duplicates.length > 1
                  ? ` (+${expense.duplicates.length - 1} more)`
                  : ""}
                .
              </span>
            </span>
            <span className="flex-1" />
            <Link
              to={`/expense/${dup.expenseId}`}
              className="text-blue-700 dark:text-blue-400 hover:underline"
            >
              View
            </Link>
            <button
              type="button"
              onClick={() =>
                onDismiss(expense.duplicates.map((d) => d.expenseId))
              }
              className="hover:underline"
            >
              Not a duplicate
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="font-semibold text-red-700 dark:text-red-400 hover:underline"
            >
              Remove
            </button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function Thumbnail({ expense }: { expense: ReturnType<typeof toListItem> }) {
  if (expense.type === "receipt") {
    return (
      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-gray-100 dark:bg-gray-700">
        {expense.imageFile ? (
          <img
            src={`/expense/${expense.id}/image?w=160&v=${encodeURIComponent(
              imageVersion(expense),
            )}`}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-gray-300 dark:text-gray-600 dark:text-gray-300">
            <ReceiptText aria-hidden="true" className="h-6 w-6" />
          </div>
        )}
      </div>
    );
  }

  // Mileage rows all share the same generic route image — a stylized
  // A → B → back trip — instead of the real route: the tiny tile can't
  // show real driving directions usefully, and the list stays consistent.
  return (
    <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-200 dark:bg-gray-600">
      <svg viewBox="0 0 56 56" className="h-full w-full" aria-hidden="true">
        {/* Outbound, A → B, along a couple of turns. */}
        <path
          d="M10 46 L24 38 L30 24 L46 12"
          fill="none"
          stroke="#2563eb"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Return, B → A, dashed to read as the way back. */}
        <path
          d="M46 12 L38 36 L10 46"
          fill="none"
          stroke="#6b7280"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="3 4"
        />
      </svg>
    </div>
  );
}
