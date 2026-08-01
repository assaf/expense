import {
  Plus,
  Trash2,
  ArrowLeft,
  MapPin,
  LogOut,
  RefreshCw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, Form, useNavigation, useSearchParams } from "react-router";
import { redirect } from "react-router";
import { Button } from "~/components/ui/Button";
import { requireUser } from "~/lib/auth.server";
import { INBOUND_EMAIL_ADDRESS } from "~/lib/env";
import { geocode } from "~/lib/maps.server";
import { readSettings, writeSettings } from "~/lib/settings.server";
import {
  addCategory,
  addInboundSender,
  addReport,
  listInboundSenders,
  readAccount,
  readCategories,
  readCategoryCounts,
  readReportCounts,
  readReports,
  regenerateInviteCode,
  removeCategory,
  removeInboundSender,
  removeReport,
  setReportClosed,
} from "~/lib/store.server";
import { normalizeAmount } from "~/lib/format";
import { entryString, formString } from "~/lib/validation";
import type { Route } from "./+types/settings";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const account = await readAccount(user.accountId);
  const [
    reports,
    categories,
    settings,
    inboundSenders,
    reportCounts,
    categoryCounts,
  ] = await Promise.all([
    readReports(user.accountId),
    readCategories(user.accountId),
    readSettings(user.accountId),
    listInboundSenders(user.accountId),
    readReportCounts(user.accountId),
    readCategoryCounts(user.accountId),
  ]);
  const years = Object.keys(settings.mileageRates).sort();
  return {
    accountName: account?.name ?? "",
    inviteCode: account?.inviteCode ?? "",
    reports: reports.map((r) => ({
      name: r.name,
      closed: r.closed,
      count: reportCounts.get(r.name) ?? 0,
    })),
    categories: categories.map((c) => ({
      name: c.name,
      count: categoryCounts.get(c.name) ?? 0,
    })),
    homeAddress: settings.homeAddress,
    inboundSenders,
    inboundAddress: INBOUND_EMAIL_ADDRESS,
    rates: years.map((y) => ({ year: y, rate: settings.mileageRates[y] })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  const form = await request.formData();
  const intent = formString(form, "intent");

  switch (intent) {
    case "regenerateCode":
      await regenerateInviteCode(user.accountId);
      break;
    case "addReport": {
      const name = formString(form, "name").trim();
      // Flash the new entry on the reloaded page (only when actually created).
      const added = await addReport(user.accountId, name);
      return added
        ? redirect(`/settings?addedReport=${encodeURIComponent(name)}`)
        : redirect("/settings");
    }
    case "removeReport":
      await removeReport(user.accountId, formString(form, "name"));
      break;
    case "setReportClosed":
      await setReportClosed(
        user.accountId,
        formString(form, "name"),
        formString(form, "closed") === "true",
      );
      break;
    case "addCategory": {
      const name = formString(form, "name").trim();
      const added = await addCategory(user.accountId, name);
      return added
        ? redirect(`/settings?addedCategory=${encodeURIComponent(name)}`)
        : redirect("/settings");
    }
    case "removeCategory":
      await removeCategory(user.accountId, formString(form, "name"));
      break;
    case "saveRates": {
      const settings = await readSettings(user.accountId);
      const rates: Record<string, string> = {};
      for (const [key, value] of form.entries()) {
        const m = key.match(/^rate\.(.+)$/);
        if (m) {
          const v = normalizeAmount(entryString(value));
          if (v) rates[m[1]] = v;
        }
      }
      // New year row.
      const newYear = formString(form, "newYear").trim();
      const newRate = normalizeAmount(formString(form, "newRate"));
      if (newYear && /^\d{4}$/.test(newYear) && newRate) {
        rates[newYear] = newRate;
      }
      settings.mileageRates = rates;
      await writeSettings(user.accountId, settings);
      break;
    }
    case "addInboundSender": {
      const address = formString(form, "address").trim().toLowerCase();
      await addInboundSender(user.accountId, address);
      break;
    }
    case "removeInboundSender": {
      const address = formString(form, "address").trim().toLowerCase();
      await removeInboundSender(user.accountId, address);
      break;
    }
    case "saveHome": {
      const settings = await readSettings(user.accountId);
      const address = formString(form, "homeAddress").trim();
      settings.homeAddress = address;
      if (address) {
        const geocoded = await geocode(address);
        settings.homeLat = geocoded.lat;
        settings.homeLng = geocoded.lng;
      } else {
        settings.homeLat = null;
        settings.homeLng = null;
      }
      await writeSettings(user.accountId, settings);
      break;
    }
    default:
      return Response.json({ error: "Unknown intent" }, { status: 400 });
  }
  return redirect("/settings");
}

export default function SettingsPage({ loaderData }: Route.ComponentProps) {
  const [searchParams] = useSearchParams();
  const {
    reports,
    categories,
    homeAddress,
    rates,
    accountName,
    inviteCode,
    inboundSenders,
    inboundAddress,
  } = loaderData;
  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <Link
        to="/"
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" /> Back
      </Link>
      <h1 className="mb-6 text-2xl font-bold">Settings</h1>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Account</h2>
        <p className="mb-3 text-sm text-gray-500">
          Everyone in this account shares expenses, reports, categories, and
          settings.
        </p>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-gray-500">
                Account name
              </div>
              <div className="font-semibold">{accountName}</div>
            </div>
            <Form method="post" className="contents">
              <input type="hidden" name="intent" value="regenerateCode" />
              <Button type="submit" size="sm" variant="secondary">
                <RefreshCw className="h-4 w-4" /> New code
              </Button>
            </Form>
          </div>
          <div>
            <div className="text-sm font-medium text-gray-500">
              Invite code — share to let someone join this account
            </div>
            <div className="font-mono text-2xl font-bold tracking-widest">
              {inviteCode}
            </div>
          </div>
        </div>
      </section>

      <NameList
        title="Reports"
        items={reports}
        addIntent="addReport"
        addPlaceholder="Add report"
        highlight={searchParams.get("addedReport") ?? undefined}
        renderItem={(report) => <ReportRow report={report} />}
      />
      <NameList
        title="Categories"
        items={categories}
        addIntent="addCategory"
        addPlaceholder="Add category"
        highlight={searchParams.get("addedCategory") ?? undefined}
        renderItem={(category) => <CategoryRow category={category} />}
      />

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Mileage rates</h2>
        <p className="mb-3 text-sm text-gray-500">
          Reimbursement rate per mile for each calendar year.
        </p>
        <Form method="post" className="flex flex-col gap-2">
          <input type="hidden" name="intent" value="saveRates" />
          {rates.map((r) => (
            <div key={r.year} className="flex items-center gap-2">
              <input
                type="text"
                name={`rate.${r.year}`}
                defaultValue={r.rate}
                className="w-24 rounded-lg border border-gray-300 px-2 py-1.5 text-right"
              />
              <span className="text-sm text-gray-500">/ mi for {r.year}</span>
            </div>
          ))}
          <div className="mt-2 flex items-center gap-2 border-t border-gray-100 pt-2">
            <input
              type="text"
              name="newYear"
              placeholder="YYYY"
              className="w-24 rounded-lg border border-gray-300 px-2 py-1.5"
            />
            <input
              type="text"
              name="newRate"
              placeholder="0.70"
              inputMode="decimal"
              className="w-24 rounded-lg border border-gray-300 px-2 py-1.5 text-right"
            />
            <span className="text-sm text-gray-500">/ mi (new year)</span>
          </div>
          <Button type="submit" size="sm" className="mt-2 self-start">
            Save rates
          </Button>
        </Form>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Home location</h2>
        <p className="mb-3 text-sm text-gray-500">
          Used as the first and last stop of every mileage route.
        </p>
        <Form method="post" className="flex items-end gap-2">
          <input type="hidden" name="intent" value="saveHome" />
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-sm font-medium text-gray-700">Address</span>
            <input
              type="text"
              name="homeAddress"
              defaultValue={homeAddress}
              className="rounded-lg border border-gray-300 px-3 py-2"
            />
          </label>
          <Button type="submit" size="md">
            <MapPin className="h-4 w-4" /> Save
          </Button>
        </Form>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Receipts by email</h2>
        <p className="mb-3 text-sm text-gray-500">
          Forward receipt emails to the address below and they are parsed
          (merchant, amount, category) and added automatically. The expense date
          is the date of the forwarded email.
        </p>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          {inboundAddress ? (
            <div className="mb-4">
              <div className="text-sm font-medium text-gray-500">
                Forward receipts to
              </div>
              <div className="font-mono text-lg font-semibold">
                {inboundAddress}
              </div>
            </div>
          ) : (
            <p className="mb-4 text-sm text-gray-400">
              Set the INBOUND_EMAIL_ADDRESS environment variable to show the
              forwarding address here.
            </p>
          )}
          <div className="mb-3">
            <div className="mb-1 text-sm font-medium text-gray-700">
              Allowed sender address(es)
            </div>
            <p className="mb-2 text-xs text-gray-500">
              The addresses you forward receipts from — you can add several.
              Only emails from these addresses are imported.
            </p>
            <ul className="flex flex-col gap-1">
              {inboundSenders.length === 0 ? (
                <li className="text-sm text-gray-400">None yet.</li>
              ) : (
                inboundSenders.map((address) => (
                  <li
                    key={address}
                    className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-1.5"
                  >
                    <span className="font-mono text-sm">{address}</span>
                    <Form method="post" className="contents">
                      <input
                        type="hidden"
                        name="intent"
                        value="removeInboundSender"
                      />
                      <input type="hidden" name="address" value={address} />
                      <button
                        type="submit"
                        className="text-gray-400 hover:text-red-600"
                        aria-label={`Remove ${address}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </Form>
                  </li>
                ))
              )}
            </ul>
          </div>
          <Form method="post" className="flex items-center gap-2">
            <input type="hidden" name="intent" value="addInboundSender" />
            <input
              type="email"
              name="address"
              placeholder="you@example.com"
              required
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2"
            />
            <Button type="submit" size="sm" variant="secondary">
              <Plus className="h-4 w-4" /> Add address
            </Button>
          </Form>
        </div>
      </section>

      <section className="border-t border-gray-100 pt-6">
        <h2 className="mb-2 text-lg font-semibold">Session</h2>
        <p className="mb-3 text-sm text-gray-500">
          Sign out of this device. You will need your username and password to
          get back in.
        </p>
        <Form method="post" action="/sign-out">
          <Button type="submit" size="md" variant="secondary">
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </Form>
      </section>
    </main>
  );
}

function NameList<T extends { name: string }>({
  title,
  items,
  addIntent,
  addPlaceholder,
  highlight,
  renderItem,
}: {
  title: string;
  items: readonly T[];
  addIntent: string;
  addPlaceholder: string;
  /** Full row content for every item in the list. */
  renderItem: (item: T) => ReactNode;
  /** The entry just added via this list's add form — flashed for 3 seconds. */
  highlight?: string;
}) {
  const navigation = useNavigation();
  const [flashName, setFlashName] = useState<string | null>(null);
  const flashRef = useRef<HTMLLIElement | null>(null);
  const addInputRef = useRef<HTMLInputElement | null>(null);
  const pendingAdd = useRef(false);

  // Flash whenever the page carries an ?added* param. React Router submits
  // the add form client-side and keeps this component mounted, so the URL
  // param arrives after mount — it can't seed useState, it must be synced.
  useEffect(() => {
    if (highlight) setFlashName(highlight);
  }, [highlight]);

  // Time-box the flash and drop the ?added* params so a refresh doesn't
  // re-flash. The router keeps the params internally after replaceState, so
  // the highlight prop stays stable and this runs once per add.
  useEffect(() => {
    if (!flashName) return;
    flashRef.current?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
    const url = new URL(window.location.href);
    url.searchParams.delete("addedReport");
    url.searchParams.delete("addedCategory");
    window.history.replaceState(null, "", url);
    const timer = setTimeout(() => setFlashName(null), 3000);
    return () => clearTimeout(timer);
  }, [flashName]);

  // Empty the add input once this list's add submission settles — the input
  // is uncontrolled, so a client-side navigation would otherwise keep its
  // value. Only reacts to this list's own intent.
  useEffect(() => {
    if (
      navigation.state === "submitting" &&
      navigation.formData?.get("intent") === addIntent
    ) {
      pendingAdd.current = true;
    } else if (navigation.state === "idle" && pendingAdd.current) {
      pendingAdd.current = false;
      if (addInputRef.current) addInputRef.current.value = "";
    }
  }, [navigation.state, navigation.formData, addIntent]);

  return (
    <section className="mb-8">
      <h2 className="mb-2 text-lg font-semibold">{title}</h2>
      <ul className="mb-3 flex flex-col gap-1">
        {items.length === 0 ? (
          <li className="text-sm text-gray-400">None yet.</li>
        ) : (
          items.map((item) => (
            <li
              key={item.name}
              ref={item.name === flashName ? flashRef : undefined}
              className={`flex items-center justify-between gap-2 rounded-lg px-3 py-1.5 transition-colors duration-500 ${
                item.name === flashName ? "bg-amber-200" : "bg-gray-50"
              }`}
            >
              {renderItem(item)}
            </li>
          ))
        )}
      </ul>
      <Form method="post" className="flex items-center gap-2">
        <input type="hidden" name="intent" value={addIntent} />
        <input
          ref={addInputRef}
          type="text"
          name="name"
          placeholder={addPlaceholder}
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2"
        />
        <Button type="submit" size="md" variant="secondary">
          <Plus className="h-4 w-4" /> Add
        </Button>
      </Form>
    </section>
  );
}

type ReportItem = { name: string; closed: boolean; count: number };

/**
 * One category row in Settings: name + the number of expenses in reports
 * that are not closed, and a delete button. Deleting a category used by
 * more than one such expense asks for confirmation first.
 */
type CategoryItem = { name: string; count: number };

function CategoryRow({ category }: { category: CategoryItem }) {
  const needsConfirm = category.count > 1;
  const countLabel =
    category.count === 0
      ? "No expenses"
      : `${category.count} expense${category.count === 1 ? "" : "s"}`;
  return (
    <>
      <span className="truncate">{category.name}</span>
      <div className="flex shrink-0 items-center gap-2">
        <span
          className="text-xs text-gray-500"
          title="Expenses in reports that are not closed"
        >
          {countLabel}
        </span>
        <Form
          method="post"
          className="contents"
          onSubmit={(e) => {
            if (needsConfirm) {
              const ok = window.confirm(
                `This category contains ${category.count} expenses in open reports. Delete it anyway?`,
              );
              if (!ok) e.preventDefault();
            }
          }}
        >
          <input type="hidden" name="intent" value="removeCategory" />
          <input type="hidden" name="name" value={category.name} />
          <button
            type="submit"
            className="text-gray-400 hover:text-red-600"
            aria-label={`Remove ${category.name}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </Form>
      </div>
    </>
  );
}

/**
 * One report row in Settings: name + Open/Closed badge, expense count, a
 * Close/Reopen toggle, and a delete button. Deleting a closed report or one
 * with several expenses asks for confirmation first.
 */
function ReportRow({ report }: { report: ReportItem }) {
  const needsConfirm = report.closed || report.count > 1;
  const countLabel =
    report.count === 0
      ? "No expenses"
      : `${report.count} expense${report.count === 1 ? "" : "s"}`;
  return (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate">{report.name}</span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
            report.closed
              ? "bg-gray-200 text-gray-600"
              : "bg-green-100 text-green-700"
          }`}
        >
          {report.closed ? "Closed" : "Open"}
        </span>
      </div>
      <span className="shrink-0 text-xs text-gray-500">{countLabel}</span>
      <div className="flex shrink-0 items-center gap-2">
        <Form method="post" className="contents">
          <input type="hidden" name="intent" value="setReportClosed" />
          <input type="hidden" name="name" value={report.name} />
          <input
            type="hidden"
            name="closed"
            value={report.closed ? "false" : "true"}
          />
          <button
            type="submit"
            className={`rounded-full border px-2 py-0.5 text-xs font-medium transition-colors ${
              report.closed
                ? "border-gray-300 text-gray-600 hover:bg-gray-200"
                : "border-green-300 text-green-700 hover:bg-green-50"
            }`}
          >
            {report.closed ? "Reopen" : "Close"}
          </button>
        </Form>
        <Form
          method="post"
          className="contents"
          onSubmit={(e) => {
            if (needsConfirm) {
              const flags: string[] = [];
              if (report.closed) flags.push("is closed");
              if (report.count > 1)
                flags.push(`contains ${report.count} expenses`);
              const loss =
                report.count > 0
                  ? ` Deleting it also deletes the expense${
                      report.count === 1 ? "" : "s"
                    } and any receipt images.`
                  : "";
              const ok = window.confirm(
                `This report ${flags.join(" and ")}.${loss} Delete it anyway?`,
              );
              if (!ok) e.preventDefault();
            }
          }}
        >
          <input type="hidden" name="intent" value="removeReport" />
          <input type="hidden" name="name" value={report.name} />
          <button
            type="submit"
            className="text-gray-400 hover:text-red-600"
            aria-label={`Remove ${report.name}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </Form>
      </div>
    </>
  );
}
