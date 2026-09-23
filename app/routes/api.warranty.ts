import { requireIntent } from "~/lib/route-helpers.server";
import { badRequest, unknownIntent } from "~/lib/validation";
import { createWarrantyFromDocument } from "~/lib/warranty-save.server";
import type { Route } from "./+types/api.warranty";

/** Reading a dropped document (vision or OCR) and filing it can take ~15s. */
export const config = { maxDuration: 60 };

/**
 * File a warranty from a document dropped on the warranty list. The whole
 * flow runs in this one request (store the file, read the fields, create the
 * record) because nothing is offered for editing in between: the drop is the
 * user saying "make a warranty out of this". The reader is the same one the
 * receipt pipeline uses (see app/lib/warranty-ai.server.ts).
 */
export async function action({ request, context }: Route.ActionArgs) {
  const { user, form, intent } = await requireIntent(request, context);
  if (intent !== "create") return unknownIntent();
  const result = await createWarrantyFromDocument(form, user.accountId);
  if (result.error) return badRequest(result.error);
  return Response.json({ ok: true, id: result.id });
}
