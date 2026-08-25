import { redirect } from "react-router";
import { Editor } from "./expense.$id";
import { requireUser } from "~/lib/auth.server";
import { loadEditorContext } from "~/lib/editor.server";
import {
  addReportAction,
  saveExpenseFromForm,
} from "~/lib/expense-save.server";
import { readDuplicateCandidates } from "~/lib/db/expenses";
import { newExpenseShell } from "~/lib/types";
import { badRequest, unknownIntent } from "~/lib/validation";
import { requireIntent } from "~/lib/route-helpers.server";
import type { Route } from "./+types/expense.new";

/**
 * The "new expense" editor. Unlike the edit route, nothing is written to the
 * database when this page opens; the expense is a skeleton in memory (with
 * today's date) and only becomes a row when the user clicks Save. Uploaded
 * receipt images are held as drafts (see /api/expense) and attached on Save.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const type =
    url.searchParams.get("type") === "mileage" ? "mileage" : "receipt";
  const expense = newExpenseShell(type);
  // The date is deliberately NOT set here: the server runs in UTC (Vercel),
  // so a server-computed "today" is tomorrow for a PST user after 4pm. The
  // editor initializes an empty date from the browser's local timezone
  // (receipt/mileage editors fall back to local today on create).
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
  const { user, form, intent } = await requireIntent(request);
  if (intent === "addReport") return addReportAction(form, user.accountId);

  if (intent !== "save") {
    return unknownIntent();
  }

  const result = await saveExpenseFromForm(form, user.accountId, null);
  if (result.error) return badRequest(result.error);
  // Carry the new expense's id home so the list can highlight it briefly.
  return redirect(`/?new=${result.id}`);
}

export default function NewExpensePage({ loaderData }: Route.ComponentProps) {
  return <Editor data={loaderData} />;
}
