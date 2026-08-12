import { redirect } from "react-router";
import type { EditorData } from "~/components/editor/editor-shared";
import { MileageEditor } from "~/components/editor/mileage-editor";
import { ReceiptEditor } from "~/components/editor/receipt-editor";
import { requireUser } from "~/lib/auth.server";
import { loadEditorContext } from "~/lib/editor.server";
import {
  addReportAction,
  saveExpenseFromForm,
} from "~/lib/expense-save.server";
import { MILEAGE_TYPE_LABELS } from "~/lib/mileage-rates";
import {
  deleteExpense,
  readExpense,
  readNeighborIds,
  readReports,
} from "~/lib/store.server";
import { formString, unknownIntent } from "~/lib/validation";
import type { Route } from "./+types/expense.$id";

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const expense = await readExpense(params.id, user.accountId);
  if (!expense) throw new Response("Not found", { status: 404 });
  // Editor context (reports, categories, merchants, home, rate) and the
  // prev/next neighbours for the ← → arrows — two targeted queries instead
  // of loading every expense.
  const [nav, context] = await Promise.all([
    readNeighborIds(user.accountId, expense),
    loadEditorContext(user.accountId, expense),
  ]);
  return { mode: "edit" as const, ...context, nav, existing: [] };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData || loaderData.mode !== "edit") return [{ title: "Expense" }];
  const e = loaderData.expense;
  if (e.type === "receipt") {
    const merchant = e.merchant || "New receipt";
    const amount = e.amount ? ` · $${e.amount}` : "";
    return [{ title: `${merchant}${amount} — Expense` }];
  }
  const label = MILEAGE_TYPE_LABELS[e.mileageType];
  const dist = e.distanceMiles ? ` · ${e.distanceMiles} mi` : "";
  return [{ title: `${label}${dist} — Expense` }];
}

export async function action({ request, params }: Route.ActionArgs) {
  const user = await requireUser(request);
  const existing = await readExpense(params.id, user.accountId);
  if (!existing) throw new Response("Not found", { status: 404 });
  const form = await request.formData();
  const intent = formString(form, "intent");

  if (intent === "delete") {
    await deleteExpense(params.id, user.accountId);
    return redirect("/");
  }

  if (intent === "addReport") return addReportAction(form, user.accountId);

  if (intent === "save") {
    // Expenses in closed reports cannot be edited.
    if (existing.report) {
      const allReports = await readReports(user.accountId);
      const closed = allReports.find(
        (r) => r.name === existing.report && r.closed,
      );
      if (closed) {
        return Response.json(
          { error: "This expense is in a closed report and cannot be edited." },
          { status: 400 },
        );
      }
    }
    const result = await saveExpenseFromForm(form, user.accountId, existing);
    if (result.error)
      return Response.json({ error: result.error }, { status: 400 });
    return redirect("/");
  }

  return unknownIntent();
}

export default function ExpenseEditor({ loaderData }: Route.ComponentProps) {
  return <Editor data={loaderData} />;
}

/** Shared entry point for both routes; keys by id so navigating to a
 * different expense remounts the editor with fresh field state. Create
 * mode keeps a stable key instead: the route loader builds a fresh shell
 * (new id) on every revalidation, and a changing key would remount the
 * editor mid-edit — wiping the draft form state. */
export function Editor({ data }: { data: EditorData }) {
  const key =
    data.mode === "create" ? `create-${data.expense.type}` : data.expense.id;
  return data.expense.type === "receipt" ? (
    <ReceiptEditor key={key} data={data} />
  ) : (
    <MileageEditor key={key} data={data} />
  );
}
