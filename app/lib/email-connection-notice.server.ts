import { readAccountUsers } from "~/lib/db/accounts";
import {
  claimEmailConnectionErrorNotified,
  readEmailConnectionById,
  releaseEmailConnectionErrorNotified,
} from "~/lib/db/email-connections";
import {
  emailShell,
  paragraph,
  valuePropFooter,
} from "~/lib/email-layout.server";
import { PUBLIC_URL } from "~/lib/env";
import { captureError } from "~/lib/errors.server";
import { escapeHtml } from "~/lib/escape";
import { isOAuthRefreshError } from "~/lib/oauth-token-refresh.server";
import { isJmapAuthError } from "~/lib/jmap.server";
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

/**
 * Whether a failure is a credential the account has to fix by reconnecting,
 * as opposed to a hiccup nobody can act on. Two provider shapes reach it, and
 * they are not the same failure:
 *  - `OAuthRefreshError`: the token endpoint refused the stored grant;
 *  - `JmapAuthError`: the provider revoked the session, with the grant
 *    itself still fine, so the refresh succeeds and the next API call 401s.
 *
 * One predicate, because the classification is a decision about the user's
 * next move rather than about a module: the review scan and every drain route
 * have to agree, or the one path that decides *whether to notify* silently
 * drops the shape the other reports.
 */
export function isDeadCredential(error: unknown): boolean {
  return isOAuthRefreshError(error) || isJmapAuthError(error);
}

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
 *  - `isDeadCredential` decides whether the account has to reconnect, and it
 *    is deliberately narrower than "the provider refused something": only a
 *    rejected grant (`OAuthRefreshError`), or a credential the session
 *    endpoint itself refused (`JmapAuthError`), counts. A timeout, a 5xx or a
 *    network failure is transient, and a revoked *session* is recoverable —
 *    `jmapCall` re-establishes it and retries, so it never reaches here,
 *  - the notice is claimed atomically, so a burst that hands one failed run
 *    to every push in it sends one email rather than one per push, and an
 *    already-notified episode is left alone,
 *  - every verified user is a recipient: an account is shared and any of its
 *    users can reconnect (a connection records no creator),
 *  - the claim is released when nothing was delivered, so a transport failure
 *    is retried by the next failure instead of silencing the episode.
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
  // Through wrappers, not just directly: the drain names each step by
  // re-throwing a labelled Error with the original as `cause`, so a bare
  // `instanceof` here silently swallowed every revoked-grant notice once a
  // step was wrapped. Both recognizers walk that chain, so both dead-
  // credential shapes are seen however deeply they were wrapped.
  if (!isDeadCredential(error)) return;

  const row = await readEmailConnectionById(connection.id);
  if (!row) return;
  // Claim before sending. The marker is written only when at least one send
  // was taken, so a transport failure is retried by the next failure instead
  // of silencing the episode; the claim is what keeps a burst to one notice.
  if (
    !(await claimEmailConnectionErrorNotified(row.id, new Date().toISOString()))
  ) {
    return;
  }

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
    // Nothing was taken (no verified user, or the transport refused), so the
    // claim is handed back and the next failure tries again.
    console.warn("[email-connection] reconnect notice not delivered", {
      connectionId: row.id,
      to: recipients.map((user) => user.email),
    });
    await releaseEmailConnectionErrorNotified(row.id).catch(() => {});
    return;
  }
  console.info("[email-connection] reconnect notice sent", {
    connectionId: row.id,
    to: delivered,
  });
}
