import { readAccountUsers } from "~/lib/db/accounts";
import {
  readEmailConnectionById,
  setEmailConnectionErrorNotified,
} from "~/lib/db/email-connections";
import {
  emailShell,
  paragraph,
  valuePropFooter,
} from "~/lib/email-layout.server";
import { PUBLIC_URL } from "~/lib/env";
import { captureError } from "~/lib/errors.server";
import { escapeHtml } from "~/lib/escape";
import { OAuthRefreshError } from "~/lib/oauth-token-refresh.server";
import { sendEmail } from "~/lib/reply.server";

/**
 * The notice that goes out when a connected mailbox stops importing because
 * the provider refused to renew the grant Expense holds for it. Receipts
 * have silently stopped arriving at that point, and the only other signal is
 * the "Needs attention" badge on the Email page, which is easy to miss for
 * months.
 *
 * It is sent from the app's own mailbox (FASTMAIL_TOKEN +
 * INBOUND_EMAIL_ADDRESS), never through the connection's credential: the
 * connection-owned senders (deliverConnectionEmailToInbox,
 * gmailSendConnectionEmailToOwner) authenticate as the mailbox that just
 * stopped working, so they cannot deliver this.
 *
 * One notice per failure episode. The episode ends when a status write goes
 * back to "active" (a renewal, a drain, a push verification, or a reconnect),
 * which clears the marker, so the next failure tells the account again.
 */

/** What the notifier needs from a connection: the public record's identity
 * columns, nothing secret. */
export interface ConnectionFailureInput {
  connection: {
    id: string;
    accountId: string;
    emailAddress: string;
    provider: string;
  };
  error: unknown;
}

/** The provider's name for the copy, matching the label its token endpoint
 * errors already carry. A generic JMAP server is not OAuth, so this only
 * ever sees the two providers. */
function providerLabel(provider: string): string {
  return provider === "gmail" ? "Google" : "Fastmail";
}

/** Where the user re-authorizes the mailbox (both routes serve the signed-in
 * Settings path and the anonymous onboarding one). */
function reconnectPath(provider: string): string {
  return provider === "gmail" ? "/connect-gmail" : "/connect-fastmail";
}

/** The sentence naming the mailbox, taking the address already rendered
 * (escaped, or plain in the text alternative) so both flavors say the same
 * thing. */
function bodySentence(emailAddress: string, provider: string): string {
  return `Receipts from ${emailAddress} have stopped importing. ${providerLabel(provider)} no longer accepts the sign-in Expense holds for that mailbox, so nothing new can be read from it.`;
}

/** The closing sentence of both flavors. */
const CLOSING =
  "Nothing already filed is affected. When you reconnect, the app looks back 90 days of that inbox, so receipts that arrived in the meantime can still be imported.";

/** The HTML body: the same sentences, the address and the reconnect URL
 * escaped (the address is user data). */
function noticeHtml(input: {
  emailAddress: string;
  provider: string;
  reconnectUrl: string;
  home: string;
}): string {
  const url = escapeHtml(input.reconnectUrl);
  return emailShell({
    title: "Your mailbox needs reconnecting",
    body: [
      paragraph(
        bodySentence(
          `<b>${escapeHtml(input.emailAddress)}</b>`,
          input.provider,
        ),
      ),
      paragraph(
        `Reconnect it: <a href="${url}" style="color:#2563eb;text-decoration:none;font-weight:600">${url}</a>`,
      ),
      paragraph(CLOSING),
    ].join("\n"),
    footer: valuePropFooter(input.home),
  });
}

/** The plain-text alternative. */
function noticeText(input: {
  emailAddress: string;
  provider: string;
  reconnectUrl: string;
}): string {
  return `${bodySentence(input.emailAddress, input.provider)}\n\nReconnect it: ${input.reconnectUrl}\n\n${CLOSING}`;
}

/**
 * Tell the account that a mailbox needs reconnecting. Never throws: it runs
 * inside cron ticks, webhook drains and the review scan, and none of those
 * may fail because a notice could not be written or delivered.
 *
 * Gating, in order:
 *  - only an `OAuthRefreshError` (the provider refused the grant) counts; a
 *    timeout, a 5xx or a network failure is transient and a 401 is app
 *    misconfiguration the recipient cannot act on,
 *  - the row is re-read, so a tick and a concurrent scan cannot both notify,
 *    and an already-notified episode is left alone,
 *  - every verified user is a recipient: an account is shared and any of its
 *    users can reconnect (a connection records no creator),
 *  - the marker is written only when at least one send was taken, so a
 *    transport failure is retried by the next failure instead of silencing
 *    the episode.
 */
export async function reportConnectionFailure(
  input: ConnectionFailureInput,
): Promise<void> {
  try {
    await notifyConnectionFailure(input);
  } catch (err) {
    captureError("[email-connection] reconnect notice failed", {
      connectionId: input.connection.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function notifyConnectionFailure({
  connection,
  error,
}: ConnectionFailureInput): Promise<void> {
  if (!(error instanceof OAuthRefreshError)) return;

  const row = await readEmailConnectionById(connection.id);
  if (!row || row.errorNotifiedAt) return;

  const recipients = (await readAccountUsers(row.accountId)).filter(
    (user) => user.emailVerifiedAt,
  );
  const home = (PUBLIC_URL || "").replace(/\/$/, "");
  const reconnectUrl = `${home}${reconnectPath(row.provider)}`;
  const copy = {
    emailAddress: row.emailAddress,
    provider: row.provider,
    reconnectUrl,
  };
  const html = noticeHtml({ ...copy, home });
  const text = noticeText(copy);

  const delivered: string[] = [];
  for (const user of recipients) {
    const ok = await sendEmail({
      to: user.email,
      subject: `${row.emailAddress} needs reconnecting on Expense`,
      text,
      html,
    });
    if (ok) delivered.push(user.email);
  }

  if (delivered.length === 0) {
    // Nothing was taken (no verified user, or the transport refused). The
    // marker stays null, so the next failure tries again.
    console.warn("[email-connection] reconnect notice not delivered", {
      connectionId: row.id,
      to: recipients.map((user) => user.email),
    });
    return;
  }
  await setEmailConnectionErrorNotified(row.id, new Date().toISOString());
  console.info("[email-connection] reconnect notice sent", {
    connectionId: row.id,
    to: delivered,
  });
}
