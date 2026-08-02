import { redirect } from "react-router";
import { Editor } from "./expense.$id";
import { requireUser } from "~/lib/auth.server";
import { saveExpenseFromForm } from "~/lib/expense-save.server";
import { todayDate, yearOf } from "~/lib/format";
import { homeLocation, readSettings } from "~/lib/settings.server";
import {
  newExpenseShell,
  readCategories,
  readPriorMerchants,
  readReports,
} from "~/lib/store.server";
import { formString } from "~/lib/validation";
import type { Route } from "./+types/expense.new";

/**
 * The "new expense" editor. Unlike the edit route, nothing is written to the
 * database when this page opens — the expense is a skeleton in memory (with
 * today's date) and only becomes a row when the user clicks Save. Uploaded
 * receipt images are held as drafts (see /api/expense) and attached on Save.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const type =
    url.searchParams.get("type") === "mileage" ? "mileage" : "receipt";
  const expense = newExpenseShell(type);
  expense.date = todayDate();
  const [reports, categories, settings, merchants] = await Promise.all([
    readReports(user.accountId),
    readCategories(user.accountId),
    readSettings(user.accountId),
    readPriorMerchants(user.accountId),
  ]);
  return {
    mode: "create" as const,
    expense,
    reports: reports.filter((r) => !r.closed).map((r) => r.name),
    categories: categories.map((c) => c.name),
    merchants,
    home: homeLocation(settings),
    rate: settings.mileageRates[yearOf(expense.date)] ?? "",
    year: yearOf(expense.date),
    nav: null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  const form = await request.formData();
  if (formString(form, "intent") !== "save") {
    return Response.json({ error: "Unknown intent." }, { status: 400 });
  }

  const error = await saveExpenseFromForm(form, user.accountId, null);
  if (error) return Response.json({ error }, { status: 400 });
  return redirect("/");
}

export default function NewExpensePage({ loaderData }: Route.ComponentProps) {
  return <Editor data={loaderData} />;
}
