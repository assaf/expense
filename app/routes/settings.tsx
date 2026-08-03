import { Plus, Trash2, Pencil, MapPin, LogOut, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Form, useFetcher } from "react-router";
import { redirect } from "react-router";
import { Button } from "~/components/ui/Button";
import { Field } from "~/components/ui/Field";
import { Input } from "~/components/ui/Input";
import { PageShell } from "~/components/PageShell";
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
  renameCategory,
  renameReport,
  setReportClosed,
} from "~/lib/store.server";
import { countLabel, normalizeAmount } from "~/lib/format";
import { entryString, formString, unknownIntent } from "~/lib/validation";
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
      // Fetcher-driven: return the created name (or the error) so the list
      // can flash the new row in place — no page navigation.
      const result = await addReport(user.accountId, name);
      return Response.json(result.ok ? { ok: true, name } : result);
    }
    case "removeReport":
      await removeReport(user.accountId, formString(form, "name"));
      break;
    case "renameReport": {
      const result = await renameReport(
        user.accountId,
        formString(form, "name"),
        formString(form, "newName"),
      );
      return Response.json(result);
    }
    case "setReportClosed":
      await setReportClosed(
        user.accountId,
        formString(form, "name"),
        formString(form, "closed") === "true",
      );
      break;
    case "addCategory": {
      const name = formString(form, "name").trim();
      const result = await addCategory(user.accountId, name);
      return Response.json(result.ok ? { ok: true, name } : result);
    }
    case "removeCategory":
      await removeCategory(user.accountId, formString(form, "name"));
      break;
    case "renameCategory": {
      const result = await renameCategory(
        user.accountId,
        formString(form, "name"),
        formString(form, "newName"),
      );
      return Response.json(result);
    }
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
      // The store normalizes the address (trim + lowercase) for storage.
      await addInboundSender(user.accountId, formString(form, "address"));
      break;
    }
    case "removeInboundSender": {
      await removeInboundSender(user.accountId, formString(form, "address"));
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
      return unknownIntent();
  }
  return redirect("/settings");
}

export default function SettingsPage({ loaderData }: Route.ComponentProps) {
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
    <PageShell title="Settings">
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
        renderItem={(report) => <ReportRow key={report.name} report={report} />}
      />
      <NameList
        title="Categories"
        items={categories}
        addIntent="addCategory"
        addPlaceholder="Add category"
        renderItem={(category) => (
          <CategoryRow key={category.name} category={category} />
        )}
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
              <Input
                type="text"
                name={`rate.${r.year}`}
                defaultValue={r.rate}
                className="w-24 px-2 py-1.5 text-right"
              />
              <span className="text-sm text-gray-500">/ mi for {r.year}</span>
            </div>
          ))}
          <div className="mt-2 flex items-center gap-2 border-t border-gray-100 pt-2">
            <Input
              type="text"
              name="newYear"
              placeholder="YYYY"
              className="w-24 px-2 py-1.5"
            />
            <Input
              type="text"
              name="newRate"
              placeholder="0.70"
              inputMode="decimal"
              className="w-24 px-2 py-1.5 text-right"
            />
            <span className="text-sm text-gray-500">/ mi (new year)</span>
          </div>
          <Button type="submit" size="sm" className="mt-2 self-start">
            Save rates
          </Button>
        </Form>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Start location</h2>
        <p className="mb-3 text-sm text-gray-500">
          Used as the start and end of every mileage route.
        </p>
        <Form method="post" className="flex items-end gap-2">
          <input type="hidden" name="intent" value="saveHome" />
          <Field label="Address" className="flex-1">
            <Input type="text" name="homeAddress" defaultValue={homeAddress} />
          </Field>
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
            <Input
              type="email"
              name="address"
              placeholder="you@example.com"
              required
              className="flex-1"
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
          Sign out of this device. You will need your email and password to get
          back in.
        </p>
        <Form method="post" action="/sign-out">
          <Button type="submit" size="md" variant="secondary">
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </Form>
      </section>
    </PageShell>
  );
}

function NameList<T extends { name: string }>({
  title,
  items,
  addIntent,
  addPlaceholder,
  renderItem,
}: {
  title: string;
  items: readonly T[];
  addIntent: string;
  addPlaceholder: string;
  /** Full row content for every item in the list. */
  renderItem: (item: T) => ReactNode;
}) {
  const fetcher = useFetcher<{ ok: boolean; name?: string; error?: string }>();
  const [flashName, setFlashName] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const flashRef = useRef<HTMLLIElement | null>(null);

  // A new entry landed (fetcher, no page navigation): flash it and clear
  // the add input. A rejected add (duplicate) shows its error inline. The
  // loader revalidation has already added the row by the time this runs,
  // so the flash ref is available on the next render.
  useEffect(() => {
    const { data } = fetcher;
    if (!data) return;
    if (data.ok && data.name) {
      setFlashName(data.name);
      setError(null);
      setDraft("");
    } else if (data.error) {
      setError(data.error);
    }
  }, [fetcher.data]);

  // Time-box the flash and bring the new row into view.
  useEffect(() => {
    if (!flashName) return;
    flashRef.current?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
    const timer = setTimeout(() => setFlashName(null), 3000);
    return () => clearTimeout(timer);
  }, [flashName]);

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
      <fetcher.Form method="post" className="flex items-center gap-2">
        <input type="hidden" name="intent" value={addIntent} />
        <Input
          type="text"
          name="name"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          placeholder={addPlaceholder}
          aria-invalid={error ? true : undefined}
          invalid={!!error}
          className="flex-1"
        />
        <Button
          type="submit"
          size="md"
          variant="secondary"
          disabled={!draft.trim()}
        >
          <Plus className="h-4 w-4" /> Add
        </Button>
      </fetcher.Form>
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
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

/**
 * Inline rename editor: an input pre-filled with the current name, Save,
 * and Cancel. Submits through a fetcher (no page navigation — the page
 * stays put, and the action's error, e.g. a duplicate name, is shown
 * inline). The row that hosts it is keyed by name, so a successful rename
 * remounts the row and closes the editor.
 */
type RenameResult = { ok: boolean; error?: string };

function RenameForm({
  intent,
  name,
  onCancel,
}: {
  intent: string;
  /** Current name — also the hidden `name` field the action matches on. */
  name: string;
  onCancel: () => void;
}) {
  const fetcher = useFetcher<RenameResult>();
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (fetcher.data?.error) setError(fetcher.data.error);
    else if (fetcher.data?.ok) setError(null);
  }, [fetcher.data]);

  return (
    <div className="flex w-full flex-col gap-1">
      <fetcher.Form method="post" className="flex w-full items-center gap-2">
        <input type="hidden" name="intent" value={intent} />
        <input type="hidden" name="name" value={name} />
        <Input
          type="text"
          name="newName"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
          }}
          autoFocus
          aria-invalid={error ? true : undefined}
          invalid={!!error}
          className="min-w-0 flex-1 px-2 py-1"
        />
        <Button
          type="submit"
          size="sm"
          disabled={!draft.trim() || draft === name}
        >
          Save
        </Button>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 text-sm text-gray-500 hover:text-ink"
        >
          Cancel
        </button>
      </fetcher.Form>
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </div>
  );
}

function RenameButton({
  onClick,
  name,
}: {
  onClick: () => void;
  name: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-gray-400 hover:text-ink"
      aria-label={`Rename ${name}`}
    >
      <Pencil className="h-4 w-4" />
    </button>
  );
}

function CategoryRow({ category }: { category: CategoryItem }) {
  const needsConfirm = category.count > 1;
  const [editing, setEditing] = useState(false);
  const removeFetcher = useFetcher();
  if (editing) {
    return (
      <RenameForm
        intent="renameCategory"
        name={category.name}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <>
      <span className="truncate">{category.name}</span>
      <div className="flex shrink-0 items-center gap-2">
        <span
          className="text-xs text-gray-500"
          title="Expenses in reports that are not closed"
        >
          {category.count === 0 ? "No expenses" : countLabel(category.count)}
        </span>
        <RenameButton onClick={() => setEditing(true)} name={category.name} />
        <removeFetcher.Form
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
        </removeFetcher.Form>
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
  const [editing, setEditing] = useState(false);
  const toggleFetcher = useFetcher();
  const removeFetcher = useFetcher();
  if (editing) {
    return (
      <RenameForm
        intent="renameReport"
        name={report.name}
        onCancel={() => setEditing(false)}
      />
    );
  }
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
      <span className="shrink-0 text-xs text-gray-500">
        {report.count === 0 ? "No expenses" : countLabel(report.count)}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <toggleFetcher.Form method="post" className="contents">
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
        </toggleFetcher.Form>
        <RenameButton onClick={() => setEditing(true)} name={report.name} />
        <removeFetcher.Form
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
        </removeFetcher.Form>
      </div>
    </>
  );
}
