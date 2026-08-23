import { FASTMAIL_TOKEN } from "~/lib/env";
import {
  pushVerificationOf,
  readFastMailPush,
} from "~/lib/fastmail-push.server";
import { setVerificationCode } from "~/lib/fastmail.server";
import { processUnprocessedReceipts } from "~/lib/inbound-fastmail.server";
import type { Route } from "./+types/api.inbound-push";

/**
 * FastMail JMAP push webhook (public — no session). FastMail POSTs an
 * encrypted RFC 8291 (aes128gcm) payload here; successful decryption is
 * itself the authentication (only a sender holding our public key can
 * produce a decryptable body).
 *
 *  - PushVerification: FastMail asks us to echo the code back before the
 *    subscription becomes verified.
 *  - StateChange: new mail arrived somewhere — drain the Receipts folder.
 *
 * Processing is best-effort and bounded (45s budget, one batch); the daily
 * cron is the catch-up net for anything a missed push leaves behind.
 */

// Vercel: the receipt pipeline (blob download + OCR + LLM) needs the full budget.
export const config = { maxDuration: 60 };

export async function action({ request }: Route.ActionArgs) {
  const payload = await readFastMailPush(request, {
    // Inbound pushes also renew the subscription (daily cron), which needs
    // the FastMail API token beyond the shared push keys.
    requiredEnv: [FASTMAIL_TOKEN],
    logTag: "[inbound-push]",
  });
  if (payload instanceof Response) return payload;

  const type = payload["@type"];

  if (type === "PushVerification") {
    // Absent fields degrade to empty strings, as the old typeof narrowing
    // did — the echo simply fails downstream.
    const { pushSubscriptionId: id, verificationCode: code } =
      pushVerificationOf(payload) ?? {
        pushSubscriptionId: "",
        verificationCode: "",
      };
    try {
      await setVerificationCode(id, code);
      console.info("[inbound-push] verified subscription", { id });
    } catch (err) {
      console.error("[inbound-push] verification update failed:", err);
      return Response.json({ error: "verification failed" }, { status: 500 });
    }
  } else if (type === "StateChange") {
    // Best effort. The daily cron is the catch-up net for anything missed.
    try {
      const result = await processUnprocessedReceipts();
      console.info("[inbound-push] processed", result);
    } catch (err) {
      console.error("[inbound-push] processing failed:", err);
    }
  } else {
    console.warn("[inbound-push] unknown payload type", { type });
  }

  return Response.json({ ok: true });
}
