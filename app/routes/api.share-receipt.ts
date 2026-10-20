import { redirect } from "react-router";
import { requireContextUser } from "~/lib/auth.server";
import { captureReceipt } from "~/lib/mcp-write.server";
import { readUploadOr400 } from "~/lib/receipt-ocr.server";
import { badRequest, formString } from "~/lib/validation";
import type { Route } from "./+types/api.share-receipt";

/** The share target runs the same extraction as a receipt upload: ~10-15s. */
export const config = { maxDuration: 20 };

/**
 * The PWA share target (the manifest's `share_target`): a photo shared
 * from another app arrives here as a multipart POST and becomes an
 * expense — the same read, extract, store and file pipeline the MCP's
 * capture_receipt uses, so a shared photo is filed like any other receipt.
 *
 * The share sheet's own text rides along as the description: what the
 * sender typed is often the note the receipt needs. The date is the
 * server's UTC today (the same default the MCP capture uses); the expense
 * is opened straight away, and its page is where a date can be corrected.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const user = requireContextUser(context, request);
  const form = await request.formData();
  const uploaded = await readUploadOr400(form);
  if (uploaded instanceof Response) return uploaded;
  const note = [formString(form, "title"), formString(form, "text")]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" — ");
  const result = await captureReceipt(user.accountId, {
    imageData: uploaded.buffer.toString("base64"),
    mime: uploaded.mime,
    filename: uploaded.originalName,
    ...(note ? { description: note } : {}),
  });
  if (result.isError) {
    return badRequest(result.content[0]?.text ?? "Couldn't file that receipt.");
  }
  const data = result.structuredContent as { expenseId?: string } | undefined;
  if (!data?.expenseId) return badRequest("Couldn't file that receipt.");
  return redirect(`/expense/${data.expenseId}`);
}
