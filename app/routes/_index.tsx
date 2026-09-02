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
  Loader2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { WelcomePanel } from "~/components/WelcomePanel";
import { cardSurface } from "~/components/ui/Card";
import {
  consumeCommandRequest,
  useCommandRequest,
} from "~/lib/command-requests";
import { Button } from "~/components/ui/Button";
import { Badge } from "~/components/ui/Badge";
import { Input } from "~/components/ui/Input";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { EmptyState } from "~/components/ui/EmptyState";
import { imageVersion } from "~/lib/image-version";
import { isComplete } from "~/lib/completeness";
import { duplicateLabel, groupDuplicateMatches } from "~/lib/duplicates";
import { matchesSearch, parseQuery } from "~/lib/expense-search";
import type { DuplicateMatch } from "~/lib/duplicates";
import { isReceiptFile } from "~/lib/file-types";
import { useDropTarget } from "~/lib/use-drop-target";
import {
  countLabel,
  formatAmount,
  formatDate,
  sortExpenses,
  summarizeAmounts,
} from "~/lib/format";
import { useToday } from "~/lib/use-today";
import { isAuthenticated, requireUser } from "~/lib/auth.server";
import { INBOUND_EMAIL_ADDRESS } from "~/lib/env";
import {
  MILEAGE_TYPE_LABELS,
  currentMileageRates,
  formatRate,
  type MileageRateEntry,
} from "~/lib/mileage-rates";
import { OG_IMAGE, SITE_URL } from "~/lib/seo-content";
import { usePasteImage } from "~/lib/use-paste-image";
import { countAccounts, readAccount } from "~/lib/db/accounts";
import { deleteExpense, readExpenses } from "~/lib/db/expenses";
import { listEmailConnections } from "~/lib/db/email-connections";
import { readReports } from "~/lib/db/reports";
import { readMileageRates } from "~/lib/db/seed";
import {
  dismissDuplicatePair,
  readDuplicateDismissals,
  readSettings,
  writeSettings,
} from "~/lib/db/settings";
import type { Expense, Location, MileageType } from "~/lib/types";
import type { DuplicateReason } from "~/lib/duplicates";
import { formString, unknownIntent } from "~/lib/validation";
import type { Route } from "./+types/_index";

export async function loader({ request }: Route.LoaderArgs) {
  // Anonymous visitors see the landing page; signed-in users see the app.
  if (!(await isAuthenticated(request))) {
    // The landing page shows how many of the 100 free spots are claimed.
    const signupCount = await countAccounts();
    return data({ mode: "landing" as const, signupCount });
  }
  const user = await requireUser(request);
  const [
    expenses,
    dismissed,
    allReports,
    rates,
    account,
    settings,
    emailConnections,
  ] = await Promise.all([
    readExpenses(user.accountId),
    readDuplicateDismissals(user.accountId),
    readReports(user.accountId),
    readMileageRates(),
    readAccount(user.accountId),
    readSettings(user.accountId),
    listEmailConnections(user.accountId),
  ]);
  // Closed reports stay off the home page: no summary card, no expenses.
  const closed = new Set(allReports.filter((r) => r.closed).map((r) => r.name));
  const open = expenses.filter((e) => !closed.has(e.report));
  const sorted = sortExpenses(open);
  // Which rows look like each other (both sides of a pair). Matched against
  // ALL expenses (including rows in closed reports), so a re-uploaded
  // receipt still warns when the original was already filed.
  const matchesByExpense = groupDuplicateMatches(expenses, dismissed);
  // The mileage-rate highlight is eligible when the account has rates; the
  // actual rate is computed CLIENT-side from the browser's local today (the
  // server runs UTC and must not guess the user's timezone).
  // The feature highlight that shows at the bottom of the list, picked at
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
    // The connect-email highlight is eligible only while the account has no
    // connected mailbox.
    hasEmailConnection: emailConnections.length > 0,
  };
  return data(
    {
      mode: "app" as const,
      expenses: sorted.map((e) => toListItem(e, matchesByExpense.get(e.id))),
      rates,
      welcomePending: settings.welcomePending,
      hasEmailConnection: emailConnections.length > 0,
      // While the account has no connected mailbox, boost the connect-email
      // highlight so the nudge shows up within a few visits (the rotation
      // still varies the rest).
      highlight: {
        id: pickHighlight(
          highlightData,
          emailConnections.length > 0 ? undefined : "connect-email",
        ),
        data: highlightData,
      },
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
 * Never cache the home page: it switches between landing (anonymous) and
 * expense list (authenticated) based on the session cookie. Browsers and
 * CDNs must revalidate on every request and segment by cookie so an
 * authenticated user never sees the cached landing page.
 */
export function headers({ loaderHeaders }: Route.HeadersArgs) {
  if (loaderHeaders.has("Cache-Control")) {
    // Already set by the loader (authenticated response); keep it.
    return { Vary: "Cookie" };
  }
  return {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Vary: "Cookie",
  };
}

/** List-level actions: dismiss a duplicate warning or delete a row.
 * Deleting from the list still goes through the confirm dialog; deletion
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

  if (intent === "welcomeDone") {
    const settings = await readSettings(user.accountId);
    await writeSettings(user.accountId, { ...settings, welcomePending: false });
    return null;
  }

  return unknownIntent();
}

/** One list row: the thin Expense projection the client filters, sums,
 * and renders. */
interface ExpenseListItem {
  id: string;
  type: "receipt" | "mileage";
  mileageType: MileageType;
  date: string;
  amount: string;
  category: string;
  report: string;
  description: string;
  complete: boolean;
  reconciled: boolean;
  imageFile: string;
  updatedAt: string;
  locations: Location[];
  distanceMiles: string;
  merchant: string;
  duplicates: {
    expenseId: string;
    reason: DuplicateReason;
    label: string;
  }[];
}

function toListItem(
  e: Expense,
  matches: DuplicateMatch[] | undefined,
): ExpenseListItem {
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
    <LandingPage
      signupCount={loaderData.mode === "landing" ? loaderData.signupCount : 0}
    />
  ) : (
    <ExpenseList
      expenses={loaderData.expenses}
      rates={loaderData.rates}
      welcomePending={loaderData.welcomePending}
      hasEmailConnection={loaderData.hasEmailConnection}
      highlight={loaderData.highlight}
    />
  );
}

function ExpenseList({
  expenses,
  rates,
  welcomePending,
  hasEmailConnection,
  highlight,
}: {
  expenses: ExpenseListItem[];
  rates: MileageRateEntry[];
  welcomePending: boolean;
  hasEmailConnection: boolean;
  highlight: { id: HighlightId; data: HighlightData };
}) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const drop = useDropTarget({
    accepts: isReceiptFile,
    onFile: uploadImage,
    message: "Receipt file detected — drop to upload",
  });
  // "Today" in the browser's own timezone; the server runs UTC and must
  // not guess the user's day, so everything that depends on it (the future
  // badge, the mileage-rate tip) is computed client-side after mount.
  const today = useToday();
  const mileageRate = useMemo(
    () =>
      today
        ? formatRate(currentMileageRates(rates, today)?.byType.business ?? "")
        : "",
    [today, rates],
  );
  // Id of the expense created just now. The create action redirects here
  // with `?new=<id>`; the row stays highlighted for three seconds.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const fetcher = useFetcher();

  // Handle one-shot palette requests this page owns (open the receipt file
  // picker / focus the search box). Only handled kinds are consumed; an
  // upload-reconcile request fired from here must survive for the reconcile
  // page, which mounts after the palette navigates. setState setters and
  // refs are stable, so `[]` deps are exhaustive.
  useCommandRequest((request) => {
    if (request.kind === "upload-expense") {
      consumeCommandRequest();
      fileRef.current?.click();
    } else if (request.kind === "search-expenses") {
      consumeCommandRequest();
      setQuery(request.query);
      setDebouncedQuery(request.query);
      searchRef.current?.focus();
    }
  });

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
  // The summary line spins while the debounce has yet to apply the typed
  // query (the 200ms gap between typing and the filtered numbers).
  const filtering = query !== debouncedQuery;
  // The list filter runs client-side: the search box matches text
  // (amount, merchant, description, category) plus the field operators.
  const parsedQuery = useMemo(
    () => parseQuery(debouncedQuery),
    [debouncedQuery],
  );
  const filtered = useMemo(
    () => expenses.filter((e) => matchesSearch(e, parsedQuery)),
    [expenses, parsedQuery],
  );
  const searchTotal = useMemo(
    () => summarizeAmounts(filtered).total,
    [filtered],
  );
  const allTotal = useMemo(() => summarizeAmounts(expenses).total, [expenses]);
  // The search box's suggestion set: every merchant and category in the
  // account, most-used first, so "how much on XYZ" is a pick, not typing.
  const suggestions = useMemo(() => {
    const merchants = new Map<string, number>();
    const categories = new Map<string, number>();
    const reports = new Map<string, number>();
    for (const e of expenses) {
      if (e.type === "receipt" && e.merchant) {
        merchants.set(e.merchant, (merchants.get(e.merchant) ?? 0) + 1);
      }
      if (e.category) {
        categories.set(e.category, (categories.get(e.category) ?? 0) + 1);
      }
      if (e.report) {
        reports.set(e.report, (reports.get(e.report) ?? 0) + 1);
      }
    }
    const byCount = (a: [string, number], b: [string, number]) =>
      b[1] - a[1] || a[0].localeCompare(b[0]);
    return {
      merchants: [...merchants.entries()].toSorted(byCount),
      categories: [...categories.entries()].toSorted(byCount),
      reports: [...reports.entries()].toSorted(byCount),
    };
  }, [expenses]);

  usePasteImage(uploadImage);

  /** Open the editor without creating anything. The row appears on Save. */
  function createExpense(type: "receipt" | "mileage") {
    void navigate(
      type === "receipt" ? "/expense/new" : "/expense/new?type=mileage",
    );
  }

  /** Carry the pasted/uploaded file into the new editor as its draft image. */
  function uploadImage(file: File) {
    void navigate("/expense/new", { state: { file } });
  }

  /** Dismiss every duplicate warning on a row: "not a duplicate" is a
   * one-click, permanent dismissal for the pair (no confirm needed: it
   * only hides a warning, it never deletes anything). */
  function dismissDuplicate(expenseId: string, otherIds: string[]) {
    const form = new FormData();
    form.set("intent", "dismiss-duplicate");
    form.set("id", expenseId);
    form.set("otherIds", otherIds.join(","));
    void fetcher.submit(form, { method: "post" });
  }

  /** Delete a row from the list, always after the confirm dialog. */
  function removeExpense() {
    if (!confirmDeleteId) return;
    const form = new FormData();
    form.set("intent", "delete");
    form.set("id", confirmDeleteId);
    setConfirmDeleteId(null);
    void fetcher.submit(form, { method: "post" });
  }

  return (
    <main
      id="main-content"
      className={`mx-auto max-w-4xl px-4 py-8 ${drop.over ? "outline-dashed outline-2 -outline-offset-2 outline-blue-500" : ""}`}
      onDragEnter={drop.onDragEnter}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
      aria-label="Expense list — drag a receipt image anywhere to upload"
    >
      <div className="sr-only" role="status" aria-live="polite">
        {drop.message}
      </div>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1>
          <Logo link />
        </h1>
        <nav className="flex items-center gap-0.5 sm:gap-2">
          <Button asChild variant="ghost" size="sm" className="px-2 sm:px-3">
            <Link
              to="/reconcile"
              data-shortcut="nav-reconcile"
              aria-label="Reconcile"
            >
              <ListChecks aria-hidden="true" className="h-4 w-4" />
              <span className="hidden sm:inline">Reconcile</span>
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm" className="px-2 sm:px-3">
            <Link to="/export" data-shortcut="nav-reports" aria-label="Reports">
              <Download aria-hidden="true" className="h-4 w-4" />
              <span className="hidden sm:inline">Reports</span>
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm" className="px-2 sm:px-3">
            <Link to="/emails" data-shortcut="nav-emails" aria-label="Email">
              <Mail aria-hidden="true" className="h-4 w-4" />
              <span className="hidden sm:inline">Email</span>
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm" className="px-2 sm:px-3">
            <Link
              to="/settings"
              data-shortcut="nav-settings"
              aria-label="Settings"
            >
              <Settings aria-hidden="true" className="h-4 w-4" />
              <span className="hidden sm:inline">Settings</span>
            </Link>
          </Button>
        </nav>
      </header>

      {welcomePending ? (
        <WelcomePanel inboundAddress={highlight.data.inboundAddress} />
      ) : null}

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Button
            data-shortcut="new-receipt"
            onClick={() => createExpense("receipt")}
            className="min-w-0 flex-1 px-2 sm:flex-none sm:px-4"
          >
            <ReceiptText aria-hidden="true" className="h-4 w-4" /> Receipt
          </Button>
          <Button
            data-shortcut="new-mileage"
            onClick={() => createExpense("mileage")}
            variant="secondary"
            className="min-w-0 flex-1 px-2 sm:flex-none sm:px-4"
          >
            <MapPinned aria-hidden="true" className="h-4 w-4" /> Mileage
          </Button>
          <Button
            type="button"
            variant="secondary"
            data-shortcut="upload-expense"
            onClick={() => fileRef.current?.click()}
            className="min-w-0 flex-1 px-2 sm:flex-none sm:px-4"
          >
            <Upload aria-hidden="true" className="h-4 w-4" /> Upload
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
        <div
          className="relative w-full sm:min-w-56 sm:flex-1"
          data-shortcut="search-expenses"
        >
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500 dark:text-gray-400"
          />
          <Input
            ref={searchRef}
            list="expense-search-suggestions"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search, or report: category: merchant: description: to filter"
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
          <datalist id="expense-search-suggestions">
            {suggestions.merchants.map(([name, count]) => (
              <option
                key={`merchant:${name}`}
                value={name}
                label={countLabel(count)}
              />
            ))}
            {suggestions.categories.map(([name, count]) => (
              <option
                key={`category:${name}`}
                value={name}
                label={`${countLabel(count)} in this category`}
              />
            ))}
            {suggestions.reports.map(([name, count]) => (
              <option
                key={`report:${name}`}
                value={`report:${name}`}
                label={`${countLabel(count)} as a report`}
              />
            ))}
            {suggestions.merchants.map(([name, count]) => (
              <option
                key={`op-merchant:${name}`}
                value={`merchant:${name}`}
                label={`${countLabel(count)} as a merchant`}
              />
            ))}
            {suggestions.categories.map(([name, count]) => (
              <option
                key={`op-category:${name}`}
                value={`category:${name}`}
                label={`${countLabel(count)} in this category`}
              />
            ))}
          </datalist>
        </div>
      </div>

      <div className="mb-3 text-sm text-gray-600 dark:text-gray-300">
        <span
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-2"
        >
          {filtering ? (
            <>
              <Loader2
                aria-hidden="true"
                className="h-3.5 w-3.5 animate-spin"
              />
              Filtering…
            </>
          ) : debouncedQuery ? (
            `Showing ${filtered.length} of ${expenses.length} expenses · ${formatAmount(searchTotal)} total`
          ) : (
            `${countLabel(expenses.length)} · ${formatAmount(allTotal)} total`
          )}
        </span>
      </div>

      {expenses.length === 0 ? (
        <EmptyState>
          <p>
            Nothing here yet. Add your first receipt or log a drive; it takes
            under a minute.
          </p>
          {!hasEmailConnection ? (
            <p className="mt-2 text-sm">
              Or connect your FastMail account and receipts from your inbox are
              added automatically, no forwarding.
            </p>
          ) : null}
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
  expense: ExpenseListItem;
  /** Browser-local today (null before mount; SSR renders without the
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
  // scrolled, so bring the highlighted row into view.
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
              ? cardSurface
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
                <Badge tone="blue" title="Dated in the future">
                  Future
                </Badge>
              ) : null}
              {expense.reconciled ? (
                <Badge
                  tone="green"
                  icon={
                    <BadgeCheck aria-hidden="true" className="h-3.5 w-3.5" />
                  }
                  title="Matched against a credit card statement"
                >
                  Reconciled
                </Badge>
              ) : null}
              {expense.category ? (
                <Badge tone="gray" square>
                  {expense.category}
                </Badge>
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

function Thumbnail({ expense }: { expense: ExpenseListItem }) {
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
          <div className="flex h-full w-full items-center justify-center text-gray-300 dark:text-gray-600">
            <ReceiptText aria-hidden="true" className="h-6 w-6" />
          </div>
        )}
      </div>
    );
  }

  // Mileage rows all share the same generic route image (a stylized
  // A → B → back trip) instead of the real route: the tiny tile can't
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
