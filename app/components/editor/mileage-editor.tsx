import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, MapPinned, Plus, X } from "lucide-react";
import MapView from "~/components/MapView";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { isComplete } from "~/lib/completeness";
import { findDuplicates } from "~/lib/duplicates";
import { escapeHtml } from "~/lib/escape";
import { todayDate } from "~/lib/format";
import {
  mileageAmount,
  mileageRateFor,
  mileageRateLabel,
} from "~/lib/mileage-rates";
import type {
  Location,
  MileageExpense,
  MileageType,
  RouteGeometry,
} from "~/lib/types";
import { geocodedLocations } from "~/lib/types";
import {
  ClosedReportBanner,
  DateAmountFields,
  DeleteConfirmDialog,
  DescriptionField,
  DuplicateWarning,
  EditorActions,
  ErrorBanner,
  ReportCategoryFields,
  Shell,
  TransitionOverlay,
  fetcherError,
  submitDelete,
  useEditorFlow,
  useFormKeys,
  type EditorData,
} from "./editor-shared";

function initLocations(expense: MileageExpense, home: Location): Location[] {
  const saved = expense.locations.map((l) => ({ ...l }));
  // A mileage expense always has a start/end and a first stop, so pad trips
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

/** "Street, city" form of a canonical address: the first two comma parts,
 * used for map tooltips so the state/country don't crowd the popup. Falls
 * back to the full address when it has fewer than two parts. */
function shortAddress(address: string): string {
  const parts = address
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.slice(0, 2).join(", ") || address;
}

export function MileageEditor({ data }: { data: EditorData }) {
  const { reports, categories, home, rates, reportClosed } = data;
  const expense = data.expense as MileageExpense;
  const isNew = data.mode === "create";
  const { fetcher, transition, doSave, doDelete, doCancel } = useEditorFlow();

  const [locations, setLocations] = useState<Location[]>(() =>
    initLocations(expense, home),
  );
  // The last geocoded result from /api/route: what the map, the distance,
  // and the saved locations use. Distinct from `locations` (the typed text)
  // so a route response can never rewrite what the user is typing. A slow,
  // stale response would otherwise yank text out from under the cursor.
  const [resolved, setResolved] = useState<Location[]>(() =>
    initLocations(expense, home),
  );
  const [distanceMiles, setDistanceMiles] = useState(expense.distanceMiles);
  const [amount, setAmount] = useState(expense.amount);
  // Create mode ships an empty date (the server can't know the user's
  // timezone), so fall back to the browser's local today. Edit mode uses the
  // stored date.
  const [date, setDate] = useState(() => expense.date || todayDate());
  const [mileageType, setMileageType] = useState<MileageType>(
    expense.mileageType,
  );
  const [report, setReport] = useState(expense.report);
  const [category, setCategory] = useState(expense.category);
  const [description, setDescription] = useState(expense.description);
  const [coords, setCoords] = useState<[number, number][]>(() =>
    // Saved driving geometry when present, empty otherwise. The map never
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
  // error, network down); cleared on the next successful geocode.
  const [routeError, setRouteError] = useState<string | null>(null);
  // Indexes of fields currently being geocoded (in-flight blur geocodes and
  // the save-time flush), which drives the per-field spinner.
  const [geocodingFields, setGeocodingFields] = useState<number[]>([]);
  const manualAmount = useRef(false);
  // The IRS rate for the trip's (date, type); it changes the moment either
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
   * different rate: recompute the amount, same as a type change. */
  function changeDate(d: string) {
    setDate(d);
    manualAmount.current = false;
    setAmount(
      mileageAmount(distanceMiles, mileageRateFor(rates, d, mileageType)),
    );
  }

  // Monotonic id for route requests: only the latest request may update
  // shared state, so an out-of-order response can't overwrite newer
  // results. Typing bumps it too, so any in-flight geocode is stale the
  // moment the addresses change.
  const requestSeq = useRef(0);
  // The latest computed route geometry, saved with the expense so the map
  // shows the driving route everywhere (list thumbnails, editor on open),
  // not just while this session's recompute result is in state.
  const lastRoute = useRef<RouteGeometry | null>(null);

  // Legacy expenses (created before routes were persisted) load with no
  // geometry; compute it once on open so the driving route appears. Until
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
   * Pure (no state writes), so callers decide what to apply. */
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
      // Everything is empty; there is no trip to compute. Return a blank
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
    // blurs without changing the trip, so no recompute. Only a field with
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
      // silently dropped: a newer request is in flight.
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
      // A non-empty field that failed to geocode is an error; tell the
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
    submitDelete(fetcher);
  }

  const error = fetcherError(fetcher.data);
  useFormKeys({
    onSave: () => void onSave(),
    onCancel: doCancel,
    disabled: fetcher.state !== "idle" || reportClosed,
    blocked: confirmDelete,
  });

  // The map shows the geocoded route (`resolved`), not the raw typed text:
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
      {reportClosed ? <ClosedReportBanner /> : null}
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
          // Geocoding + OSRM can take a couple of seconds, so a pill centered
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
          <div className="flex items-center gap-2 border-t border-gray-100 dark:border-gray-800 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-600 dark:text-red-400">
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
        disabled={reportClosed}
        onManualAmount={() => {
          manualAmount.current = true;
        }}
      />

      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
            Locations
          </span>
          {!reportClosed ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={addLocation}
            >
              <Plus aria-hidden="true" className="h-4 w-4" /> Add stop
            </Button>
          ) : null}
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
                    disabled={reportClosed}
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
              {/* The start/end and the first stop are required; only extra
                  stops can be removed. */}
              {i >= 2 && !reportClosed ? (
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
        disabled={reportClosed}
      />

      <DescriptionField
        value={description}
        onChange={setDescription}
        disabled={reportClosed}
      />

      <EditorActions
        complete={isNew ? true : complete}
        saving={fetcher.state !== "idle"}
        onCancel={doCancel}
        onSave={() => void onSave()}
        onDelete={isNew ? undefined : () => setConfirmDelete(true)}
        saveLabel={duplicateMatches.length > 0 ? "Save anyway" : undefined}
        readOnly={reportClosed}
      />
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
