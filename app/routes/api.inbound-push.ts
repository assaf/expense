import { FASTMAIL_TOKEN, PUSH_AUTH, PUSH_PRIVATE_KEY } from "~/lib/env";
import { decryptPushBody } from "~/lib/fastmail-push.server";
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

const MAX_BODY_BYTES = 1024 * 1024; // a push payload is a few KB

export async function action({ request }: Route.ActionArgs) {
  if (!FASTMAIL_TOKEN || !PUSH_PRIVATE_KEY || !PUSH_AUTH) {
    return Response.json(
      { error: "FastMail push is not configured on this deployment" },
      { status: 503 },
    );
  }
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }

  const body = Buffer.from(await request.arrayBuffer());
  if (body.byteLength > MAX_BODY_BYTES) {
    return Response.json({ error: "body too large" }, { status: 413 });
  }

  let payload: { "@type": string; [key: string]: unknown };
  try {
    payload = decryptPushBody(body, PUSH_PRIVATE_KEY, PUSH_AUTH);
  } catch (err) {
    console.warn("[inbound-push] decrypt failed:", err);
    return Response.json({ error: "decrypt failed" }, { status: 400 });
  }

  const type = payload["@type"];

  if (type === "PushVerification") {
    const id =
      typeof payload["pushSubscriptionId"] === "string"
        ? payload["pushSubscriptionId"]
        : "";
    const code =
      typeof payload["verificationCode"] === "string"
        ? payload["verificationCode"]
        : "";
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
