import { redirect } from "react-router";
import { WarrantyEditor } from "~/components/editor/warranty-editor";
import { requireContextUser } from "~/lib/auth.server";
import { readExpense } from "~/lib/db/expenses";
import { loadWarrantyEditorOptions } from "~/lib/editor.server";
import { requireIntent } from "~/lib/route-helpers.server";
import { newWarrantyShell } from "~/lib/types";
import { badRequest, unknownIntent } from "~/lib/validation";
import { termsForMerchant } from "~/lib/warranty-policies";
import { saveWarrantyFromForm } from "~/lib/warranty-save.server";
import type { Route } from "./+types/warranty.new";

/**
 * The "new warranty" editor. Nothing is written when this page opens: the
 * warranty is a skeleton in memory and only becomes a row on Save.
 * `?expenseId=` prefills it from the receipt it was opened from (the
 * warranty card on the expense editor links here).
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireContextUser(context, request);
  const expenseId = new URL(request.url).searchParams.get("expenseId") ?? "";
  const [options, linked] = await Promise.all([
    loadWarrantyEditorOptions(user.accountId),
    expenseId ? readExpense(expenseId, user.accountId) : undefined,
  ]);
  const warranty = newWarrantyShell();
  if (linked && linked.type === "receipt") {
    warranty.merchant = linked.merchant;
    // The receipt's total is the starting value; the covered product's own
    // value may differ and stays editable.
    warranty.value = linked.amount;
    warranty.purchasedAt = linked.date;
    warranty.expenseId = linked.id;
    // A merchant with a curated policy starts the record with its terms
    // filled; the field stays editable.
    warranty.terms = termsForMerchant(linked.merchant);
  }
  return { mode: "create" as const, warranty, ...options };
}

export function meta(): Route.MetaDescriptors {
  return [{ title: "New warranty — Expense" }];
}

export async function action({ request, context }: Route.ActionArgs) {
  const { user, form, intent } = await requireIntent(request, context);
  if (intent !== "save") return unknownIntent();
  const result = await saveWarrantyFromForm(form, user.accountId, null);
  if (result.error) return badRequest(result.error);
  // Carry the new warranty's id to the list so it can highlight it briefly.
  return redirect(`/warranties?new=${result.id}`);
}

export default function NewWarrantyPage({ loaderData }: Route.ComponentProps) {
  return <WarrantyEditor data={loaderData} />;
}
