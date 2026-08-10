import { INBOUND_EMAIL_WEBHOOK_SECRET } from "~/lib/env";
import {
  processInboundEvent,
  verifyWebhookSignature,
} from "~/lib/inbound-email.server";
import type {
  EmailReceivedData,
  ProcessResult,
} from "~/lib/inbound-email.server";
import type { Route } from "./+types/api.inbound-email";

/**
 * Resend inbound webhook (email.received). Public — no session — so the
 * Resend-Signature header is verified before anything is touched.
 *
 * The webhook only carries metadata; the pipeline fetches the email body,
 * headers, and attachments from the Resend API, processes them, and replies
 * by email when something fails. Webhook retries are idempotent.
 */

// Vercel: allow the pipeline (attachment download + OCR + LLM) up to 60s.
export const config = { maxDuration: 15 };

function isEmailReceivedEvent(value: unknown): value is {
  type: string;
  data: EmailReceivedData;
} {
  if (!value || typeof value !== "object") return false;
  const v = value as { type?: unknown; data?: unknown };
  return v.type === "email.received" && Boolean(v.data);
}

export async function action({ request }: Route.ActionArgs) {
  if (!INBOUND_EMAIL_WEBHOOK_SECRET) {
    return Response.json(
      { error: "Inbound email is not configured on this deployment" },
      { status: 500 },
    );
  }
  const rawBody = await request.text();
  const verified = verifyWebhookSignature(
    {
      id: request.headers.get("svix-id"),
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
    },
    rawBody,
    INBOUND_EMAIL_WEBHOOK_SECRET,
  );
  if (!verified) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }
  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isEmailReceivedEvent(event)) {
    return Response.json({ ok: true });
  }
  let result: ProcessResult;
  try {
    result = await processInboundEvent(event.data);
  } catch (err) {
    // processInboundEvent handles its own failures, but a hard error (DB
    // down, reply send throwing) must still surface as non-2xx so Resend
    // marks the delivery failed and retries instead of silently dropping it.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[inbound] webhook processing threw:", err);
    return Response.json({ error: message }, { status: 500 });
  }
  console.info(`[inbound] ${result.status} — ${event.data.email_id}`);
  if (result.status === "error") {
    // A processing failure has to be a non-2xx response: the webhook
    // dashboard then shows the delivery as failed, and Resend retries
    // (the pipeline is idempotent per email_id, and the error reply is
    // sent only once — see processInboundEvent).
    return Response.json({ error: result.error }, { status: 500 });
  }
  return Response.json({ ok: true, result });
}
