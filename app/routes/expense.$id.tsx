import { useEffect, useMemo, useRef, useState } from "react";
import {
  Trash2,
  Upload,
  X,
  Plus,
  MapPinned,
  Loader2,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useFetcher, useNavigate } from "react-router";
import { Link, redirect } from "react-router";
import MapView from "~/components/MapView";
import { Button } from "~/components/ui/Button";
import { isComplete } from "~/lib/completeness";
import { normalizeAmount, todayDate, yearOf } from "~/lib/format";
import { renameImageToConvention } from "~/lib/images.server";
import { homeLocation, readSettings } from "~/lib/settings.server";
import {
  deleteExpense,
  readCategories,
  readExpense,
  readExpenses,
  readPriorMerchants,
  readReports,
  upsertExpense,
} from "~/lib/store.server";
import type {
  Expense,
  Location,
  ReceiptExpense,
  MileageExpense,
} from "~/lib/types";
import { formString, validateDateNotFuture } from "~/lib/validation";
import type { Route } from "./+types/expense.$id";

export async function loader({ params }: Route.LoaderArgs) {
  const expense = await readExpense(params.id);
  if (!expense) throw new Response("Not found", { status: 404 });
  const [reports, categories, settings, merchants, all] = await Promise.all([
    readReports(),
    readCategories(),
    readSettings(),
    readPriorMerchants(),
    readExpenses(),
  ]);
  const year = yearOf(expense.date);
  const rate = settings.mileageRates[year] ?? "";
  // Neighbours in the main list order (newest first, empty dates last).
  const sorted = [...all].sort(sortByDateDesc);
  const i = sorted.findIndex((e) => e.id === expense.id);
  const nav = {
    prevId: i > 0 ? sorted[i - 1]!.id : null,
    nextId: i >= 0 && i < sorted.length - 1 ? sorted[i + 1]!.id : null,
  };
  return {
    expense: serializeExpense(expense),
    reports: reports.map((r) => r.name),
    categories: categories.map((c) => c.name),
    merchants,
    home: homeLocation(settings),
    rate,
    year,
    nav,
  };
}

function sortByDateDesc(a: Expense, b: Expense): number {
  if (!a.date && !b.date) return b.createdAt.localeCompare(a.createdAt);
  if (!a.date) return 1;
  if (!b.date) return -1;
  return b.date.localeCompare(a.date);
}

function serializeExpense(e: Expense) {
  return e;
}

export async function action({ request, params }: Route.ActionArgs) {
  const existing = await readExpense(params.id);
  if (!existing) throw new Response("Not found", { status: 404 });
  const form = await request.formData();
  const intent = formString(form, "intent");

  if (intent === "delete") {
    await deleteExpense(params.id);
    return redirect("/");
  }

  if (intent === "save") {
    const date = formString(form, "date");
    const dateError = validateDateNotFuture(date);
    if (dateError) return Response.json({ error: dateError }, { status: 400 });

    const report = formString(form, "report");
    const category = formString(form, "category");
    const description = formString(form, "description");
    const amount = normalizeAmount(formString(form, "amount"));
    const now = new Date().toISOString();

    if (existing.type === "receipt") {
      const merchant = formString(form, "merchant").trim();
      const updated: ReceiptExpense = {
        ...existing,
        date,
        report,
        category,
        description,
        amount,
        merchant,
        updatedAt: now,
      };
      if (updated.imageFile) {
        updated.imageFile = await renameImageToConvention(
          updated.imageFile,
          date,
          report,
          updated.originalName,
          updated.imageMime,
        );
      }
      await upsertExpense(updated);
    } else {
      const locationsRaw = formString(form, "locations");
      const locations = safeParseLocations(locationsRaw);
      const distanceMiles = formString(form, "distanceMiles");
      const updated: MileageExpense = {
        ...existing,
        date,
        report,
        category,
        description,
        amount,
        locations,
        distanceMiles,
        updatedAt: now,
      };
      await upsertExpense(updated);
    }
    return redirect("/");
  }

  return Response.json({ error: "Unknown intent" }, { status: 400 });
}

function safeParseLocations(raw: string): Location[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (v): v is Record<string, unknown> => v != null && typeof v === "object",
      )
      .map((v) => ({
        address: typeof v.address === "string" ? v.address : "",
        lat: typeof v.lat === "number" ? v.lat : null,
        lng: typeof v.lng === "number" ? v.lng : null,
      }));
  } catch {
    return [];
  }
}

export default function ExpenseEditor({ loaderData }: Route.ComponentProps) {
  const { expense } = loaderData;
  // key by id so navigating to a different expense remounts the editor with
  // fresh field state (useState initializers re-run from the new loaderData).
  return expense.type === "receipt" ? (
    <ReceiptEditor key={expense.id} data={loaderData} />
  ) : (
    <MileageEditor key={expense.id} data={loaderData} />
  );
}

function Shell({
  title,
  nav,
  children,
}: {
  title: string;
  nav?: { prevId: string | null; nextId: string | null };
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-4 flex items-center justify-between">
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
        {nav ? (
          <div className="flex items-center gap-1">
            <Link
              to={`/expense/${nav.prevId}`}
              aria-label="Previous expense"
              className={
                nav.prevId
                  ? "inline-flex items-center text-gray-500 hover:text-ink"
                  : "pointer-events-none text-gray-300"
              }
            >
              <ChevronLeft className="h-5 w-5" />
            </Link>
            <Link
              to={`/expense/${nav.nextId}`}
              aria-label="Next expense"
              className={
                nav.nextId
                  ? "inline-flex items-center text-gray-500 hover:text-ink"
                  : "pointer-events-none text-gray-300"
              }
            >
              <ChevronRight className="h-5 w-5" />
            </Link>
          </div>
        ) : null}
      </div>
      <h1 className="mb-6 text-2xl font-bold">{title}</h1>
      {children}
    </main>
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
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium text-gray-700">{label}</span>
      <select
        className="rounded-lg border border-gray-300 px-3 py-2"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">—</option>
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

// --- Receipt editor --------------------------------------------------------

function ReceiptEditor({ data }: { data: Route.ComponentProps["loaderData"] }) {
  const { reports, categories, merchants } = data;
  const expense = data.expense as ReceiptExpense;
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [date, setDate] = useState(expense.date);
  const [merchant, setMerchant] = useState(expense.merchant);
  const [amount, setAmount] = useState(expense.amount);
  const [report, setReport] = useState(expense.report);
  const [category, setCategory] = useState(expense.category);
  const [description, setDescription] = useState(expense.description);
  const [imageVersion, setImageVersion] = useState(0);
  const [lightbox, setLightbox] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [transition, setTransition] = useState<null | "save" | "cancel">(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  async function replaceImage(file: File) {
    const form = new FormData();
    form.set("intent", "upload");
    form.set("file", file);
    await fetch(`/expense/${expense.id}/image`, { method: "POST", body: form });
    setImageVersion((v) => v + 1);
  }

  // Paste an image anywhere to replace the receipt image.
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            void replaceImage(file);
            return;
          }
        }
      }
    };
    document.addEventListener("paste", handler);
    return () => document.removeEventListener("paste", handler);
  }, [expense.id]);

  function onSave() {
    const form = new FormData();
    form.set("intent", "save");
    form.set("date", date);
    form.set("merchant", merchant);
    form.set("amount", amount);
    form.set("report", report);
    form.set("category", category);
    form.set("description", description);
    void fetcher.submit(form, { method: "post" });
  }

  const doSave = () => {
    setTransition("save");
    onSave();
  };
  const doCancel = () => {
    setTransition("cancel");
    navigate("/");
  };
  // Clear the overlay if the submission finishes without navigating (validation error).
  useEffect(() => {
    if (fetcher.state === "idle" && transition === "save") setTransition(null);
  }, [fetcher.state, transition]);

  async function onDelete() {
    const form = new FormData();
    form.set("intent", "delete");
    void fetcher.submit(form, { method: "post" });
  }

  const error = fetcherError(fetcher.data);
  useFormKeys({
    onSave: doSave,
    onCancel: doCancel,
    disabled: fetcher.state !== "idle",
    blocked: lightbox || confirmDelete,
  });

  return (
    <Shell title={expense.merchant || "New receipt"} nav={data.nav}>
      {error ? (
        <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <div className="mb-6">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700">
            Receipt image
          </span>
          <span className="flex gap-1">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
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
              <Upload className="h-4 w-4" /> Replace
            </Button>
            {expense.imageFile ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={async () => {
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
                <Trash2 className="h-4 w-4" />
              </Button>
            ) : null}
          </span>
        </div>
        {expense.imageFile ? (
          <button
            type="button"
            onClick={() => setLightbox(true)}
            className="block w-full overflow-hidden rounded-xl border border-gray-200 bg-gray-50"
          >
            <img
              key={imageVersion}
              src={`/expense/${expense.id}/image?v=${imageVersion}`}
              alt="Receipt"
              className="max-h-80 w-full object-contain"
            />
          </button>
        ) : (
          <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-gray-300 text-sm text-gray-400">
            No image. Upload or paste one (⌘V).
          </div>
        )}
        <p className="mt-1 text-xs text-gray-400">
          Click the image to view full screen.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-gray-700">Date</span>
          <input
            type="date"
            tabIndex={-1}
            max={todayDate()}
            className="rounded-lg border border-gray-300 px-3 py-2"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-gray-700">Amount</span>
          <input
            type="number"
            step="0.01"
            inputMode="decimal"
            placeholder="0.00"
            className="rounded-lg border border-gray-300 px-3 py-2"
            value={amount}
            onClick={(e) => e.currentTarget.select()}
            onChange={(e) => setAmount(e.target.value)}
            onBlur={(e) => setAmount(normalizeAmount(e.target.value))}
          />
        </label>
      </div>

      <label className="mt-4 flex flex-col gap-1">
        <span className="text-sm font-medium text-gray-700">Merchant</span>
        <input
          type="text"
          list="merchants"
          className="rounded-lg border border-gray-300 px-3 py-2"
          value={merchant}
          onChange={(e) => setMerchant(e.target.value)}
        />
        <datalist id="merchants">
          {merchants.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <SelectField
          label="Report"
          value={report}
          onChange={setReport}
          options={reports}
        />
        <SelectField
          label="Category"
          value={category}
          onChange={setCategory}
          options={categories}
        />
      </div>

      <label className="mt-4 flex flex-col gap-1">
        <span className="text-sm font-medium text-gray-700">Description</span>
        <textarea
          rows={3}
          className="rounded-lg border border-gray-300 px-3 py-2"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      <EditorActions
        complete={complete}
        saving={fetcher.state !== "idle"}
        onCancel={doCancel}
        onSave={doSave}
        onDelete={() => setConfirmDelete(true)}
      />

      {lightbox && expense.imageFile ? (
        <Lightbox
          src={`/expense/${expense.id}/image?v=${imageVersion}`}
          onClose={() => setLightbox(false)}
        />
      ) : null}
      {confirmDelete ? (
        <ConfirmDialog
          message="Delete this expense? This cannot be undone."
          onConfirm={onDelete}
          onCancel={() => setConfirmDelete(false)}
          deleting={fetcher.state !== "idle"}
        />
      ) : null}
      {transition ? <TransitionOverlay kind={transition} /> : null}
    </Shell>
  );
}

// --- Mileage editor --------------------------------------------------------

function MileageEditor({ data }: { data: Route.ComponentProps["loaderData"] }) {
  const { reports, categories, home, rate } = data;
  const expense = data.expense as MileageExpense;
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();

  const [locations, setLocations] = useState<Location[]>(() =>
    initLocations(expense, home),
  );
  const [distanceMiles, setDistanceMiles] = useState(expense.distanceMiles);
  const [amount, setAmount] = useState(expense.amount);
  const [date, setDate] = useState(expense.date);
  const [report, setReport] = useState(expense.report);
  const [category, setCategory] = useState(expense.category);
  const [description, setDescription] = useState(expense.description);
  const [coords, setCoords] = useState<[number, number][]>(
    straightLine(locations),
  );
  const [approximate, setApproximate] = useState(false);
  const [computing, setComputing] = useState(false);
  const [transition, setTransition] = useState<null | "save" | "cancel">(null);
  const manualAmount = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSig = useRef("");

  // Recompute route + amount when locations or rate change (debounced).
  useEffect(() => {
    const sig = locations.map((l) => l.address).join("|") + "@" + rate;
    // Skip when nothing relevant changed (e.g. coords just got filled in).
    if (sig === lastSig.current) return;
    lastSig.current = sig;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const hasAddresses = locations.some((l) => l.address.trim());
      if (!hasAddresses) {
        setDistanceMiles("");
        if (!manualAmount.current) setAmount("");
        setCoords([]);
        return;
      }
      setComputing(true);
      try {
        const res = await fetch("/api/route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ locations, rate }),
        });
        if (res.ok) {
          const json = (await res.json()) as {
            locations: Location[];
            distanceMiles: string;
            amount: string;
            coords: [number, number][];
            approximate: boolean;
          };
          setLocations(json.locations);
          setDistanceMiles(json.distanceMiles);
          if (!manualAmount.current) setAmount(json.amount);
          setCoords(json.coords);
          setApproximate(json.approximate);
        }
      } finally {
        setComputing(false);
      }
    }, 600);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [locations, rate]);

  function updateLocation(i: number, address: string) {
    manualAmount.current = false;
    setLocations((prev) =>
      prev.map((l, idx) =>
        idx === i ? { ...l, address, lat: null, lng: null } : l,
      ),
    );
  }

  function addLocation() {
    setLocations((prev) => [...prev, { address: "", lat: null, lng: null }]);
  }

  function removeLocation(i: number) {
    manualAmount.current = false;
    setLocations((prev) => prev.filter((_, idx) => idx !== i));
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

  function onSave() {
    const form = new FormData();
    form.set("intent", "save");
    form.set("date", date);
    form.set("amount", amount);
    form.set("report", report);
    form.set("category", category);
    form.set("description", description);
    form.set("distanceMiles", distanceMiles);
    form.set("locations", JSON.stringify(locations));
    void fetcher.submit(form, { method: "post" });
  }

  const doSave = () => {
    setTransition("save");
    onSave();
  };
  const doCancel = () => {
    setTransition("cancel");
    navigate("/");
  };
  useEffect(() => {
    if (fetcher.state === "idle" && transition === "save") setTransition(null);
  }, [fetcher.state, transition]);

  const error = fetcherError(fetcher.data);
  useFormKeys({
    onSave: doSave,
    onCancel: doCancel,
    disabled: fetcher.state !== "idle",
    blocked: false,
  });

  const stops = locations
    .filter((l) => l.lat !== null && l.lng !== null)
    .map((l, i) => ({
      lat: l.lat as number,
      lng: l.lng as number,
      label: i === 0 ? "Home" : `Stop ${i}`,
    }));

  return (
    <Shell title="Mileage expense" nav={data.nav}>
      {error ? (
        <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <div className="mb-6 overflow-hidden rounded-xl border border-gray-200">
        <MapView coords={coords} stops={stops} height={260} interactive />
        <div className="flex items-center justify-between border-t border-gray-100 bg-gray-50 px-3 py-2 text-sm">
          <span className="flex items-center gap-2 text-gray-600">
            {computing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <MapPinned className="h-4 w-4" />
            )}
            {distanceMiles ? `${distanceMiles} mi` : "—"}
            {approximate ? (
              <span className="text-xs text-amber-600">(approx.)</span>
            ) : null}
          </span>
          <span className="text-gray-500">
            Route: {rate ? `$${rate}/mi` : "no rate set"}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-gray-700">Date</span>
          <input
            type="date"
            tabIndex={-1}
            max={todayDate()}
            className="rounded-lg border border-gray-300 px-3 py-2"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-gray-700">Amount</span>
          <input
            type="number"
            step="0.01"
            inputMode="decimal"
            placeholder="0.00"
            className="rounded-lg border border-gray-300 px-3 py-2"
            value={amount}
            onClick={(e) => e.currentTarget.select()}
            onChange={(e) => {
              manualAmount.current = true;
              setAmount(e.target.value);
            }}
            onBlur={(e) => setAmount(normalizeAmount(e.target.value))}
          />
        </label>
      </div>

      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700">Locations</span>
          <Button type="button" variant="ghost" size="sm" onClick={addLocation}>
            <Plus className="h-4 w-4" /> Add stop
          </Button>
        </div>
        <ol className="flex flex-col gap-2">
          {locations.map((l, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-xs font-medium text-gray-500">
                {i === 0 ? "Home" : `Stop ${i}`}
              </span>
              <input
                type="text"
                placeholder="Address"
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2"
                value={l.address}
                onChange={(e) => updateLocation(i, e.target.value)}
              />
              <button
                type="button"
                className="text-gray-400 hover:text-red-600"
                onClick={() => removeLocation(i)}
                aria-label="Remove location"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
          {locations.length === 0 ? (
            <li className="rounded-lg border border-dashed border-gray-300 p-3 text-sm text-gray-400">
              No locations. Add one to start a route.
            </li>
          ) : null}
        </ol>
        <p className="mt-1 text-xs text-gray-400">
          The route runs Home → stops → Home. Distance updates automatically.
        </p>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <SelectField
          label="Report"
          value={report}
          onChange={setReport}
          options={reports}
        />
        <SelectField
          label="Category"
          value={category}
          onChange={setCategory}
          options={categories}
        />
      </div>

      <label className="mt-4 flex flex-col gap-1">
        <span className="text-sm font-medium text-gray-700">Description</span>
        <textarea
          rows={3}
          className="rounded-lg border border-gray-300 px-3 py-2"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      <EditorActions
        complete={complete}
        saving={fetcher.state !== "idle"}
        onCancel={doCancel}
        onSave={doSave}
        onDelete={() => {
          const form = new FormData();
          form.set("intent", "delete");
          void fetcher.submit(form, { method: "post" });
        }}
      />
      {transition ? <TransitionOverlay kind={transition} /> : null}
    </Shell>
  );
}

function initLocations(expense: MileageExpense, home: Location): Location[] {
  if (expense.locations.length > 0)
    return expense.locations.map((l) => ({ ...l }));
  const first: Location = home.address
    ? { ...home }
    : { address: "", lat: null, lng: null };
  return [first, { address: "", lat: null, lng: null }];
}

function straightLine(locations: Location[]): [number, number][] {
  return locations
    .filter((l) => l.lat !== null && l.lng !== null)
    .map((l) => [l.lat as number, l.lng as number]);
}

// --- Shared editor chrome --------------------------------------------------

function EditorActions({
  complete,
  saving,
  onCancel,
  onSave,
  onDelete,
}: {
  complete: boolean;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="mt-8 flex items-center justify-between border-t border-gray-200 pt-4">
      <Button
        type="button"
        variant="danger"
        tabIndex={-1}
        onClick={onDelete}
        disabled={saving}
      >
        <Trash2 className="h-4 w-4" /> Delete
      </Button>
      <div className="flex items-center gap-2">
        {!complete ? (
          <span className="text-sm text-amber-700">Incomplete</span>
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
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/85"
      onClick={onClose}
    >
      <div className="flex justify-end p-3">
        <button
          className="text-white"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label="Close"
        >
          <X className="h-7 w-7" />
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
      // Inputs with a <datalist> (e.g. merchant autocomplete): Enter picks the
      // suggestion, so let the browser handle it and don't submit.
      const hasList = !!target?.getAttribute?.("list");
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
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
function TransitionOverlay({ kind }: { kind: "save" | "cancel" }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/60 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-2 text-gray-600">
        <Loader2 className="h-7 w-7 animate-spin" />
        <span className="text-sm font-medium">
          {kind === "save" ? "Saving…" : "Closing…"}
        </span>
      </div>
    </div>
  );
}

function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
  deleting,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  deleting: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-4 text-center text-gray-700">{message}</p>
        <div className="flex justify-center gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </div>
    </div>
  );
}
