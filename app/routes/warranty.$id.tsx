import { redirect } from "react-router";
import { WarrantyEditor } from "~/components/editor/warranty-editor";
import { requireContextUser } from "~/lib/auth.server";
import {
  deleteWarranty,
  readWarranty,
  upsertWarranty,
} from "~/lib/db/warranties";
import { loadWarrantyEditorOptions } from "~/lib/editor.server";
import { deleteImage } from "~/lib/images.server";
import { requireIntent } from "~/lib/route-helpers.server";
import {
  badRequest,
  formString,
  notFound,
  unknownIntent,
} from "~/lib/validation";
import { saveWarrantyFromForm } from "~/lib/warranty-save.server";
import type { Route } from "./+types/warranty.$id";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = requireContextUser(context, request);
  const warranty = await readWarranty(params.id, user.accountId);
  if (!warranty) throw notFound();
  const options = await loadWarrantyEditorOptions(user.accountId);
  return { mode: "edit" as const, warranty, ...options };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: "Warranty" }];
  return [{ title: `${loaderData.warranty.product || "Warranty"} — Expense` }];
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { user, form, intent } = await requireIntent(request, context);
  const existing = await readWarranty(params.id, user.accountId);
  if (!existing) throw notFound();

  if (intent === "save") {
    const result = await saveWarrantyFromForm(form, user.accountId, existing);
    if (result.error) return badRequest(result.error);
    // Stay on the page: the fetcher's revalidation refreshes the documents.
    return { ok: true };
  }

  if (intent === "delete") {
    await deleteWarranty(params.id, user.accountId);
    return redirect("/warranties");
  }

  if (intent === "removeDocument") {
    // Removing a document is its own intent, so a save can never drop a
    // stored document (documents are appended on save, never replaced).
    const key = formString(form, "key");
    const documents = existing.documents.filter((d) => d.key !== key);
    if (documents.length !== existing.documents.length) {
      await upsertWarranty(
        { ...existing, documents, updatedAt: new Date().toISOString() },
        user.accountId,
      );
      // The blob is dropped only after the row no longer names it; nothing
      // else references it (every upload mints a fresh key).
      await deleteImage(user.accountId, key);
    }
    return { ok: true };
  }

  return unknownIntent();
}

export default function WarrantyPage({ loaderData }: Route.ComponentProps) {
  return <WarrantyEditor data={loaderData} />;
}
