import { Plus, Trash2, ArrowLeft, MapPin } from "lucide-react";
import { Link, Form } from "react-router";
import { redirect } from "react-router";
import { Button } from "~/components/ui/Button";
import { geocode } from "~/lib/maps.server";
import { readSettings, writeSettings } from "~/lib/settings.server";
import {
  addCategory,
  addReport,
  readCategories,
  readReports,
  removeCategory,
  removeReport,
} from "~/lib/store.server";
import { normalizeAmount } from "~/lib/format";
import { entryString, formString } from "~/lib/validation";
import type { Route } from "./+types/settings";

export async function loader(_: Route.LoaderArgs) {
  const [reports, categories, settings] = await Promise.all([
    readReports(),
    readCategories(),
    readSettings(),
  ]);
  const years = Object.keys(settings.mileageRates).sort();
  return {
    reports: reports.map((r) => r.name),
    categories: categories.map((c) => c.name),
    homeAddress: settings.homeAddress,
    rates: years.map((y) => ({ year: y, rate: settings.mileageRates[y] })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = formString(form, "intent");

  switch (intent) {
    case "addReport":
      await addReport(formString(form, "name"));
      break;
    case "removeReport":
      await removeReport(formString(form, "name"));
      break;
    case "addCategory":
      await addCategory(formString(form, "name"));
      break;
    case "removeCategory":
      await removeCategory(formString(form, "name"));
      break;
    case "saveRates": {
      const settings = await readSettings();
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
      await writeSettings(settings);
      break;
    }
    case "saveHome": {
      const settings = await readSettings();
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
      await writeSettings(settings);
      break;
    }
    default:
      return Response.json({ error: "Unknown intent" }, { status: 400 });
  }
  return redirect("/settings");
}

export default function SettingsPage({ loaderData }: Route.ComponentProps) {
  const { reports, categories, homeAddress, rates } = loaderData;
  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <Link
        to="/"
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" /> Back
      </Link>
      <h1 className="mb-6 text-2xl font-bold">Settings</h1>

      <NameList
        title="Reports"
        items={reports}
        addIntent="addReport"
        removeIntent="removeReport"
      />
      <NameList
        title="Categories"
        items={categories}
        addIntent="addCategory"
        removeIntent="removeCategory"
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
    </main>
  );
}

function NameList({
  title,
  items,
  addIntent,
  removeIntent,
}: {
  title: string;
  items: string[];
  addIntent: string;
  removeIntent: string;
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-2 text-lg font-semibold">{title}</h2>
      <ul className="mb-3 flex flex-col gap-1">
        {items.length === 0 ? (
          <li className="text-sm text-gray-400">None yet.</li>
        ) : (
          items.map((name) => (
            <li
              key={name}
              className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-1.5"
            >
              <span>{name}</span>
              <Form method="post" className="contents">
                <input type="hidden" name="intent" value={removeIntent} />
                <input type="hidden" name="name" value={name} />
                <button
                  type="submit"
                  className="text-gray-400 hover:text-red-600"
                  aria-label={`Remove ${name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </Form>
            </li>
          ))
        )}
      </ul>
      <Form method="post" className="flex items-center gap-2">
        <input type="hidden" name="intent" value={addIntent} />
        <input
          type="text"
          name="name"
          placeholder={`Add ${title.toLowerCase().slice(0, -1)}`}
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2"
        />
        <Button type="submit" size="md" variant="secondary">
          <Plus className="h-4 w-4" /> Add
        </Button>
      </Form>
    </section>
  );
}
