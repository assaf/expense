import { redirect } from "react-router";
import { Editor } from "./expense.$id";
import { requireUser } from "~/lib/auth.server";
import { normalizeAmount, todayDate, yearOf } from "~/lib/format";
import { renameImageToConvention } from "~/lib/images.server";
import { homeLocation, readSettings } from "~/lib/settings.server";
import {
  newExpenseShell,
  readCategories,
  readPriorMerchants,
  readReports,
  upsertExpense,
} from "~/lib/store.server";
import {
  parseLocations,
  type MileageExpense,
  type ReceiptExpense,
} from "~/lib/types";
import { formString, validateDateNotFuture } from "~/lib/validation";
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

  const date = formString(form, "date");
  const dateError = validateDateNotFuture(date);
  if (dateError) return Response.json({ error: dateError }, { status: 400 });

  const report = formString(form, "report");
  if (report) {
    const reports = await readReports(user.accountId);
    if (reports.some((r) => r.name === report && r.closed)) {
      return Response.json(
        { error: `Report "${report}" is closed.` },
        { status: 400 },
      );
    }
  }
  const category = formString(form, "category");
  const description = formString(form, "description");
  const amount = normalizeAmount(formString(form, "amount"));
  const now = new Date().toISOString();

  if (formString(form, "type") === "mileage") {
    const expense: MileageExpense = {
      ...(newExpenseShell("mileage") as MileageExpense),
      date,
      report,
      category,
      description,
      amount,
      locations: parseLocations(formString(form, "locations")),
      distanceMiles: formString(form, "distanceMiles"),
      updatedAt: now,
    };
    await upsertExpense(expense, user.accountId);
  } else {
    const draftKey = formString(form, "draftKey");
    const expense: ReceiptExpense = {
      ...(newExpenseShell("receipt") as ReceiptExpense),
      date,
      report,
      category,
      description,
      amount,
      merchant: formString(form, "merchant").trim(),
      // A draft image becomes the expense's image; the convention rename
      // below moves it into the dated/report-named key.
      imageFile: draftKey,
      imageMime: draftKey ? formString(form, "draftMime") : "",
      originalName: draftKey ? formString(form, "draftOriginalName") : "",
      updatedAt: now,
    };
    if (expense.imageFile) {
      expense.imageFile = await renameImageToConvention(
        user.accountId,
        expense.imageFile,
        date,
        report,
        expense.originalName,
        expense.imageMime,
      );
    }
    await upsertExpense(expense, user.accountId);
  }
  return redirect("/");
}

export default function NewExpensePage({ loaderData }: Route.ComponentProps) {
  return <Editor data={loaderData} />;
}
