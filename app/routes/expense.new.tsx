import { redirect } from "react-router";
import { Editor } from "./expense.$id";
import { requireUser } from "~/lib/auth.server";
import { loadEditorContext } from "~/lib/editor.server";
import { saveExpenseFromForm } from "~/lib/expense-save.server";
import { todayDate } from "~/lib/format";
import {
  addReport,
  newExpenseShell,
  readDuplicateCandidates,
} from "~/lib/store.server";
import { formString, unknownIntent } from "~/lib/validation";
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
  // Existing expenses feed the live duplicate warning in the create editor.
  const [context, existing] = await Promise.all([
    loadEditorContext(user.accountId, expense),
    readDuplicateCandidates(user.accountId),
  ]);
  // New mileage expenses default to the Travel category when the account has
  // one (the IRS Schedule C bucket every new account is seeded with).
  if (expense.type === "mileage" && context.categories.includes("Travel")) {
    expense.category = "Travel";
  }
  return { mode: "create" as const, ...context, existing, nav: null };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  const form = await request.formData();
  const intent = formString(form, "intent");
  if (intent === "addReport") {
    // Fetcher-driven (no page navigation): return the created name or the
    // error so the editor's Report picker can select the new report.
    const name = formString(form, "name").trim();
    const result = await addReport(user.accountId, name);
    return Response.json(result.ok ? { ok: true, name } : result);
  }
  if (intent !== "save") {
    return unknownIntent();
  }

  const result = await saveExpenseFromForm(form, user.accountId, null);
  if (result.error)
    return Response.json({ error: result.error }, { status: 400 });
  // Carry the new expense's id home so the list can highlight it briefly.
  return redirect(`/?new=${result.id}`);
}

export default function NewExpensePage({ loaderData }: Route.ComponentProps) {
  return <Editor data={loaderData} />;
}
