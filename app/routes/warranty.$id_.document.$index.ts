import { requireContextUser } from "~/lib/auth.server";
import { readWarranty } from "~/lib/db/warranties";
import { imageResponseHeaders, readImage } from "~/lib/images.server";
import { notFound, sanitizeFilenamePart } from "~/lib/validation";
import type { Route } from "./+types/warranty.$id_.document.$index";

/**
 * Serve one warranty document (a receipt, a terms PDF, a card statement).
 * The key is write-once: every upload mints a new key and a removal deletes
 * it, so the bytes behind a key never change and the response can be cached
 * immutably. No thumbnail variant: a document is a document.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = requireContextUser(context, request);
  const warranty = await readWarranty(params.id, user.accountId);
  const index = Number(params.index);
  const document = Number.isInteger(index)
    ? warranty?.documents[index]
    : undefined;
  if (!document) throw notFound();

  const image = await readImage(user.accountId, document.key);
  if (!image) throw notFound();

  const name = sanitizeFilenamePart(document.name) || "document";
  return new Response(new Uint8Array(image.buffer) as BodyInit, {
    headers: {
      ...imageResponseHeaders(
        image.mime,
        "private, max-age=31536000, immutable",
      ),
      "Content-Disposition": `inline; filename="${name}"`,
    },
  });
}
