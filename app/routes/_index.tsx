import {
  Upload,
  MapPinned,
  ReceiptText,
  Settings,
  Download,
  Mail,
  Info,
} from "lucide-react";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import LandingPage from "~/components/LandingPage";
import MapView from "~/components/MapView";
import { Button } from "~/components/ui/Button";
import { isComplete } from "~/lib/completeness";
import {
  countLabel,
  formatAmount,
  formatDate,
  sortExpenses,
  summarizeByReport,
} from "~/lib/format";
import { isAuthenticated, requireUser } from "~/lib/auth.server";
import { INBOUND_EMAIL_ADDRESS } from "~/lib/env";
import { readSettings } from "~/lib/settings.server";
import { usePasteImage } from "~/lib/use-paste-image";
import {
  readExpenses,
  readPriorMerchants,
  readReports,
} from "~/lib/store.server";
import { geocodedLocations, type Expense } from "~/lib/types";
import type { Route } from "./+types/_index";

export async function loader({ request }: Route.LoaderArgs) {
  // Anonymous visitors see the landing page; signed-in users see the app.
  if (!(await isAuthenticated(request))) {
    return { mode: "landing" as const };
  }
  const user = await requireUser(request);
  const [expenses, settings, merchants, allReports] = await Promise.all([
    readExpenses(user.accountId),
    readSettings(user.accountId),
    readPriorMerchants(user.accountId),
    readReports(user.accountId),
  ]);
  // Closed reports stay off the home page: no summary card, no expenses.
  const closed = new Set(allReports.filter((r) => r.closed).map((r) => r.name));
  const open = expenses.filter((e) => !closed.has(e.report));
  const sorted = sortExpenses(open);
  const currentYear = String(new Date().getFullYear());
  const reports = [...summarizeByReport(open, { includeUnassigned: true })]
    .map(([name, s]) => ({ name, count: s.count, total: s.total.toFixed(2) }))
    .sort((a, b) =>
      a.name === "Unassigned"
        ? 1
        : b.name === "Unassigned"
          ? -1
          : a.name.localeCompare(b.name),
    );
  return {
    mode: "app" as const,
    expenses: sorted.map(toListItem),
    mileageRate: settings.mileageRates[currentYear] ?? "",
    merchants,
    reports,
    inboundAddress: INBOUND_EMAIL_ADDRESS,
  };
}

function toListItem(e: Expense) {
  return {
    id: e.id,
    type: e.type,
    date: e.date,
    amount: e.amount,
    category: e.category,
    report: e.report,
    complete: isComplete(e),
    imageFile: e.type === "receipt" ? e.imageFile : "",
    locations: e.type === "mileage" ? e.locations : [],
    distanceMiles: e.type === "mileage" ? e.distanceMiles : "",
    merchant: e.type === "mileage" ? "" : e.merchant,
  };
}

const SITE_URL = "https://expense.labnotes.org";

export function meta({ loaderData }: Route.MetaArgs) {
  if (loaderData?.mode === "landing") {
    return [
      { title: "Expense — every receipt, ready for tax season" },
      {
        name: "description",
        content:
          "Expense collects your receipts — snapped, pasted, or forwarded from email — reads the amount and merchant with OCR, and files each expense into IRS-style categories and reports for tax season.",
      },
      { property: "og:url", content: SITE_URL },
      {
        property: "og:title",
        content: "Expense — every receipt, ready for tax season",
      },
      {
        property: "og:description",
        content:
          "Snap or forward a receipt and the merchant, amount, and category are filled in automatically. Organized into reports and IRS-style categories, export-ready at tax time.",
      },
      { property: "og:type", content: "website" },
      { property: "og:image", content: `${SITE_URL}/screenshot-og.png` },
    ];
  }
  return [{ title: "Expenses" }];
}

export default function IndexPage({ loaderData }: Route.ComponentProps) {
  return loaderData.mode === "landing" ? (
    <LandingPage />
  ) : (
    <ExpenseList
      expenses={loaderData.expenses}
      mileageRate={loaderData.mileageRate}
      reports={loaderData.reports}
      inboundAddress={loaderData.inboundAddress}
    />
  );
}

function ExpenseList({
  expenses,
  mileageRate,
  reports,
  inboundAddress,
}: {
  expenses: ReturnType<typeof toListItem>[];
  mileageRate: string;
  reports: { name: string; count: number; total: string }[];
  inboundAddress: string;
}) {
  const [selectedReport, setSelectedReport] = useState<string | null>(null);
  const [showEmailHelp, setShowEmailHelp] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

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

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Expenses</h1>
        <nav className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link to="/export">
              <Download className="h-4 w-4" /> Export
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to="/settings">
              <Settings className="h-4 w-4" /> Settings
            </Link>
          </Button>
        </nav>
      </header>

      <div className="mb-6 flex flex-wrap gap-2">
        <Button onClick={() => createExpense("receipt")}>
          <ReceiptText className="h-4 w-4" /> Add receipt
        </Button>
        <Button onClick={() => createExpense("mileage")} variant="secondary">
          <MapPinned className="h-4 w-4" /> Add mileage
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="h-4 w-4" /> Upload image
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
        <p className="basis-full text-xs text-gray-400">
          Tip: upload an image or PDF, or paste an image (⌘V) anywhere to create
          a receipt — the amount, merchant, and category are filled in
          automatically.
          {mileageRate
            ? ` Current mileage rate: $${mileageRate}/mi.`
            : " Set a mileage rate in Settings."}
        </p>
      </div>

      {inboundAddress ? (
        <div className="mb-6 rounded-xl border border-gray-200 bg-white p-3">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 shrink-0 text-gray-400" />
            <span className="min-w-0 text-sm text-gray-600">
              Send receipts to{" "}
              <span className="font-mono font-semibold text-gray-800">
                {inboundAddress}
              </span>
            </span>
            <button
              type="button"
              onClick={() => setShowEmailHelp((v) => !v)}
              aria-expanded={showEmailHelp}
              aria-label="Receipt email instructions"
              className="ml-auto shrink-0 rounded-full p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            >
              <Info className="h-4 w-4" />
            </button>
          </div>
          {showEmailHelp ? (
            <div className="mt-2 border-t border-gray-100 pt-2">
              <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-gray-500">
                <li>
                  Forward a receipt email to the address above and it is added
                  automatically — merchant, amount, and category are parsed for
                  you.
                </li>
                <li>The expense date is the date of the forwarded email.</li>
                <li>PDF and image attachments are supported.</li>
                <li>
                  Only emails from your allowed sender addresses are imported —
                  manage them in Settings → Receipts by email.
                </li>
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {reports.length > 0 ? (
        <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {reports.map((r) => {
            const active = selectedReport === r.name;
            return (
              <button
                key={r.name}
                type="button"
                onClick={() => setSelectedReport(active ? null : r.name)}
                className={`rounded-xl border p-3 text-left transition-colors ${active ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500" : "border-gray-200 bg-white hover:border-gray-300"}`}
              >
                <div className="truncate text-sm font-medium text-gray-700">
                  {r.name}
                </div>
                <div className="text-lg font-semibold tabular-nums">
                  {formatAmount(r.total)}
                </div>
                <div className="text-xs text-gray-500">
                  {countLabel(r.count)}
                </div>
              </button>
            );
          })}
        </section>
      ) : null}

      {selectedReport ? (
        <div className="mb-3 flex items-center justify-between text-sm text-gray-600">
          <span>
            Showing{" "}
            {selectedReport === "Unassigned" ? "unassigned" : selectedReport}{" "}
            expenses
          </span>
          <button
            type="button"
            className="text-blue-600 hover:underline"
            onClick={() => setSelectedReport(null)}
          >
            Show all
          </button>
        </div>
      ) : null}

      {expenses.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="flex flex-col gap-2">
          {expenses
            .filter((e) =>
              selectedReport === null
                ? true
                : selectedReport === "Unassigned"
                  ? e.report === ""
                  : e.report === selectedReport,
            )
            .map((e) => (
              <ExpenseRow key={e.id} expense={e} />
            ))}
        </ul>
      )}
    </main>
  );
}

function ExpenseRow({ expense }: { expense: ReturnType<typeof toListItem> }) {
  const to = `/expense/${expense.id}`;
  return (
    <li>
      <Link
        to={to}
        className={`flex items-center gap-4 rounded-xl border p-3 transition-colors hover:border-gray-400 ${
          expense.complete
            ? "border-gray-200 bg-white"
            : "border-amber-300 bg-amber-50"
        }`}
      >
        <Thumbnail expense={expense} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate font-medium">
              {expense.type === "receipt"
                ? expense.merchant || "Untitled receipt"
                : "Mileage"}
            </span>
            <span className="shrink-0 font-semibold tabular-nums">
              {formatAmount(expense.amount)}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-gray-500">
            <span>{formatDate(expense.date)}</span>
            {expense.category ? (
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">
                {expense.category}
              </span>
            ) : null}
            {expense.report ? <span>{expense.report}</span> : null}
            {!expense.complete ? (
              <span className="font-medium text-amber-700">Incomplete</span>
            ) : null}
          </div>
        </div>
      </Link>
    </li>
  );
}

function Thumbnail({ expense }: { expense: ReturnType<typeof toListItem> }) {
  if (expense.type === "receipt") {
    return (
      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-gray-100">
        {expense.imageFile ? (
          <img
            src={`/expense/${expense.id}/image?w=160`}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-gray-300">
            <ReceiptText className="h-6 w-6" />
          </div>
        )}
      </div>
    );
  }

  const stops = geocodedLocations(expense.locations).map((l) => ({
    lat: l.lat,
    lng: l.lng,
  }));
  const loop = stops.length >= 2 ? [...stops, stops[0]] : stops;
  return (
    <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-gray-200">
      {stops.length >= 2 ? (
        <MapView
          coords={loop.map((s) => [s.lat, s.lng])}
          stops={stops}
          height={56}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-gray-300">
          <MapPinned className="h-6 w-6" />
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 p-12 text-center text-gray-500">
      No expenses yet. Add a receipt or mileage expense to get started.
    </div>
  );
}
