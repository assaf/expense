import {
  Upload,
  MapPinned,
  ReceiptText,
  Settings,
  Download,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import MapView from "~/components/MapView";
import { Button } from "~/components/ui/Button";
import { isComplete } from "~/lib/completeness";
import { formatAmount, formatDate } from "~/lib/format";
import { readSettings } from "~/lib/settings.server";
import {
  initStore,
  readExpenses,
  readPriorMerchants,
} from "~/lib/store.server";
import type { Expense } from "~/lib/types";
import type { Route } from "./+types/_index";

export async function loader(_: Route.LoaderArgs) {
  await initStore();
  const [expenses, settings, merchants] = await Promise.all([
    readExpenses(),
    readSettings(),
    readPriorMerchants(),
  ]);
  const sorted = [...expenses].sort(sortByDateDesc);
  const currentYear = String(new Date().getFullYear());
  return {
    expenses: sorted.map(toListItem),
    mileageRate: settings.mileageRates[currentYear] ?? "",
    merchants,
  };
}

function sortByDateDesc(a: Expense, b: Expense): number {
  // Empty dates sort last.
  if (!a.date && !b.date) return b.createdAt.localeCompare(a.createdAt);
  if (!a.date) return 1;
  if (!b.date) return -1;
  return b.date.localeCompare(a.date);
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

export default function IndexPage({ loaderData }: Route.ComponentProps) {
  const { expenses, mileageRate } = loaderData;
  const fileRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  usePasteImage(uploadImage);

  async function createExpense(type: "receipt" | "mileage") {
    setBusy(true);
    try {
      const form = new FormData();
      form.set("intent", "create");
      form.set("type", type);
      const res = await fetch("/api/expense", { method: "POST", body: form });
      if (res.ok) {
        const json = (await res.json()) as { id?: string };
        if (json.id) void navigate(`/expense/${json.id}`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function uploadImage(file: File) {
    setBusy(true);
    const form = new FormData();
    form.set("intent", "upload");
    form.set("file", file);
    try {
      const res = await fetch("/api/expense", { method: "POST", body: form });
      if (res.ok) {
        const json = (await res.json()) as { id?: string };
        if (json.id) void navigate(`/expense/${json.id}`);
      }
    } finally {
      setBusy(false);
    }
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
        <Button onClick={() => void createExpense("receipt")} disabled={busy}>
          <ReceiptText className="h-4 w-4" /> Add receipt
        </Button>
        <Button
          onClick={() => void createExpense("mileage")}
          variant="secondary"
          disabled={busy}
        >
          <MapPinned className="h-4 w-4" /> Add mileage
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          <Upload className="h-4 w-4" /> Upload image
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) void uploadImage(f);
            e.currentTarget.value = "";
          }}
        />
        {busy ? (
          <span className="self-center text-sm text-gray-500">Saving…</span>
        ) : null}
        <p className="basis-full text-xs text-gray-400">
          Tip: paste an image (⌘V) anywhere to create a receipt.
          {mileageRate
            ? ` Current mileage rate: $${mileageRate}/mi.`
            : " Set a mileage rate in Settings."}
        </p>
      </div>

      {expenses.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="flex flex-col gap-2">
          {expenses.map((e) => (
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
            src={`/expense/${expense.id}/image`}
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

  const stops = expense.locations
    .filter((l) => l.lat !== null && l.lng !== null)
    .map((l) => ({ lat: l.lat!, lng: l.lng! }));
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

/** Listen for paste events containing an image and forward the file. */
function usePasteImage(onPaste: (file: File) => void) {
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            onPaste(file);
            return;
          }
        }
      }
    };
    document.addEventListener("paste", handler);
    return () => document.removeEventListener("paste", handler);
  }, [onPaste]);
}
