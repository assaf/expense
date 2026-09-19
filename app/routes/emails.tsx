import { Mail } from "lucide-react";
import { redirect } from "react-router";
import { PageShell } from "~/components/PageShell";
import { EmailAccountsSection } from "~/components/settings/email-accounts";
import {
  AddSenderForm,
  SenderRow,
} from "~/components/settings/receipts-by-email";
import { Card } from "~/components/ui/Card";
import { FieldLabel } from "~/components/ui/FieldLabel";
import { Section } from "~/components/ui/Section";
import { StatusNote } from "~/components/ui/StatusNote";
import { requireContextUser } from "~/lib/auth.server";
import { requireIntent } from "~/lib/route-helpers.server";
import { INBOUND_EMAIL_ADDRESS } from "~/lib/env";
import { sendVerificationEmail } from "~/lib/sender-verification.server";
import { readAccount } from "~/lib/db/accounts";
import {
  addInboundSender,
  listInboundSenders,
  removeInboundSender,
  resendInboundSenderVerification,
} from "~/lib/db/inbound";
import {
  listEmailConnections,
  readEmailConnection,
  removeEmailConnection,
  createEmailConnection,
} from "~/lib/db/email-connections";
import { isGmailOAuthConfigured } from "~/lib/google-oauth.server";
import {
  isTokenCryptoConfigured,
  encryptSecret,
} from "~/lib/token-crypto.server";
import { isFastmailOAuthConfigured } from "~/lib/fastmail-oauth.server";
import {
  destroyConnectionPushSubscription,
  ensureConnectionPushSubscription,
} from "~/lib/email-connection-push.server";
import {
  learnAuthservId,
  tryMailboxIdByRole,
} from "~/lib/email-connection-mail.server";
import {
  verifyJmapServer,
  resolveJmapSessionUrl,
  JmapMethodError,
  type JmapServer,
} from "~/lib/jmap.server";
import { SsrfError } from "~/lib/ssrf.server";
import { captureWarning } from "~/lib/errors.server";
import { badRequest, formString, unknownIntent } from "~/lib/validation";
import type { Route } from "./+types/emails";

/**
 * Email: how receipts get into Expense by email. Two features:
 *
 * 1. Connected email accounts: a user's own mailbox (Fastmail via JMAP,
 *    Gmail over the Gmail API), connected through the provider's OAuth flow,
 *    whose receipts are imported automatically (expense added, email moved to
 *    Trash, and a reply with an edit link lands in the inbox).
 * 2. Receipts by email: a dedicated forward-to address; forwarding a receipt
 *    email there parses and adds it (only from verified sender addresses).
 */

// The two callbacks share the same five failure codes; only the provider
// names differ. Keyed by provider so the pairing stays obvious.
const OAUTH_ERROR_TEXT = {
  fastmail: {
    state:
      "The Fastmail connection attempt expired or did not match; try again.",
    denied: "Fastmail consent was not granted; nothing was connected.",
    exchange: "Fastmail could not exchange the authorization; try again.",
    verify:
      "Fastmail approved the connection but the token failed verification; try again.",
    unconfigured:
      "Connecting with Fastmail is not configured on this deployment.",
  },
  gmail: {
    state: "The Gmail connection attempt expired or did not match; try again.",
    denied: "Gmail consent was not granted; nothing was connected.",
    exchange: "Google could not exchange the authorization; try again.",
    verify:
      "Google approved the connection but the Gmail check failed; try again.",
    unconfigured: "Connecting with Gmail is not configured on this deployment.",
  },
} as const;

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireContextUser(context, request);
  const [inboundSenders, emailConnections] = await Promise.all([
    listInboundSenders(user.accountId),
    listEmailConnections(user.accountId),
  ]);
  // Post-OAuth-redirect landing params (set by fastmail-oauth-callback).
  const params = new URL(request.url).searchParams;
  const connected = params.get("connected");
  const oauthError = params.get("oauthError");
  const gmailOauthError = params.get("gmailOauthError");
  const oauthNotice = connected
    ? connected === "1"
      ? {
          ok: true,
          text: `${params.get("address") ?? "The mailbox"} ${
            params.get("reconnected")
              ? "reconnected with fresh credentials"
              : "connected"
          }; expenses will import automatically.`,
        }
      : { ok: false, text: params.get("reason") ?? "Could not connect." }
    : oauthError && Object.hasOwn(OAUTH_ERROR_TEXT.fastmail, oauthError)
      ? {
          ok: false,
          text: OAUTH_ERROR_TEXT.fastmail[
            oauthError as keyof typeof OAUTH_ERROR_TEXT.fastmail
          ],
        }
      : gmailOauthError &&
          Object.hasOwn(OAUTH_ERROR_TEXT.gmail, gmailOauthError)
        ? {
            ok: false,
            text: OAUTH_ERROR_TEXT.gmail[
              gmailOauthError as keyof typeof OAUTH_ERROR_TEXT.gmail
            ],
          }
        : null;
  return {
    userEmail: user.email,
    inboundAddress: INBOUND_EMAIL_ADDRESS,
    inboundSenders,
    emailConnections,
    emailAccountsConfigured: isTokenCryptoConfigured(),
    oauthConfigured: isFastmailOAuthConfigured(),
    googleConfigured: isGmailOAuthConfigured(),
    oauthNotice,
  };
}

export function meta(): Route.MetaDescriptors {
  return [{ title: "Email — Expense" }];
}

export async function action({ request, context }: Route.ActionArgs) {
  const { user, form, intent } = await requireIntent(request, context);

  // Both send paths share the same email: the verification link for a
  // pending sender address, addressed with the account's display name.
  const sendVerification = async (address: string, token: string) => {
    const account = await readAccount(user.accountId);
    await sendVerificationEmail({
      to: address,
      token,
      origin: new URL(request.url).origin,
      accountName: account?.name ?? "",
    });
  };
  // Both send paths share the same follow-up: a failure is echoed as JSON,
  // and a minted token emails that link. `token: null` means the address
  // was already verified for this account, OR the INB-BOMB-1 cooldown
  // suppressed the mint (recent: true) — a verification email went out
  // recently, so nothing is sent and the UI says so.
  const finishSender = async (
    result:
      | {
          ok: true;
          address: string;
          token: string | null;
          recent?: boolean;
        }
      | { ok: false; error: string },
  ) => {
    if (!result.ok) return Response.json(result);
    if (result.token) await sendVerification(result.address, result.token);
    return Response.json({
      ok: true,
      address: result.address,
      ...(result.recent ? { recent: true } : {}),
    });
  };
  switch (intent) {
    case "addInboundSender":
      return finishSender(
        await addInboundSender(user.accountId, formString(form, "address")),
      );
    case "resendInboundSenderVerification":
      return finishSender(
        await resendInboundSenderVerification(
          user.accountId,
          formString(form, "address"),
        ),
      );
    case "removeInboundSender": {
      await removeInboundSender(user.accountId, formString(form, "address"));
      break;
    }
    case "disconnectEmail": {
      const id = formString(form, "id");
      const connection = await readEmailConnection(user.accountId, id);
      if (connection) {
        // Best effort: tear down the server-side push subscription with
        // the user's token. A failure (revoked token, Fastmail down) still
        // disconnects. The orphaned subscription dies at expiry and its
        // pushes hit the webhook's unknown-connection path.
        try {
          if (connection.pushSubscriptionId) {
            await destroyConnectionPushSubscription(
              connection,
              connection.pushSubscriptionId,
            );
          }
        } catch (err) {
          console.warn("[email-connections] subscription teardown failed", {
            id: connection.id,
            err,
          });
        }
      }
      const removed = await removeEmailConnection(user.accountId, id);
      console.info("[email-connections] disconnected", {
        accountId: user.accountId,
        removed,
      });
      return Response.json({ ok: true });
    }
    case "connectJmapServer": {
      const rawUrl = formString(form, "serverUrl").trim();
      const authMode = formString(form, "authMode");
      const username = formString(form, "username").trim();
      const secret = formString(form, "secret");
      if (!rawUrl) return badRequest("Enter the server's URL.");
      if (!secret) return badRequest("Enter the token or app password.");
      if (authMode === "basic" && !username) {
        return badRequest("Enter the username for that app password.");
      }
      // Normalize to the RFC 8620 session URL and require TLS (§8.1). The
      // explicit path a user pastes is kept verbatim.
      let sessionUrl: string;
      try {
        sessionUrl = resolveJmapSessionUrl(rawUrl);
        if (new URL(sessionUrl).protocol !== "https:") {
          return badRequest("Use the server's https URL.");
        }
      } catch {
        return badRequest("That is not a valid URL.");
      }
      const authorization =
        authMode === "basic"
          ? `Basic ${Buffer.from(`${username}:${secret}`).toString("base64")}`
          : `Bearer ${secret}`;
      const server: JmapServer = { sessionUrl, authorization };
      const verified = await verifyJmapServer(server);
      if (!verified.ok) return badRequest(verified.message);
      // Require a real Inbox before writing anything: without one there is
      // no mail the drain could read (RFC 8621 §2.5 makes roles optional).
      try {
        const inbox = await tryMailboxIdByRole(server, "inbox");
        if (!inbox) {
          return badRequest(
            "This account has no Inbox mailbox, so there is no mail to read.",
          );
        }
      } catch (err) {
        return badRequest(
          err instanceof SsrfError
            ? err.message
            : "That server could not list its mailboxes; try again.",
        );
      }
      const authservId = await learnAuthservId(
        server,
        verified.info.mailAccountId,
      );
      // tokenEnc holds the finished Authorization header for a JMAP row
      // (see email-connection-auth.server.ts), never a bare token.
      const tokenEnc = encryptSecret(authorization);
      const result = await createEmailConnection({
        accountId: user.accountId,
        provider: "jmap",
        emailAddress: verified.info.username,
        remoteAccountId: verified.info.mailAccountId,
        tokenEnc,
        sessionUrl,
        authservId,
      });
      if (!result.ok) return badRequest(result.error);
      // Best-effort push: a server without PushSubscription still works
      // through the daily drain, so a failure here never fails the connect.
      try {
        await ensureConnectionPushSubscription({
          id: result.connection.id,
          provider: "jmap",
          sessionUrl,
          tokenEnc,
        });
      } catch (err) {
        if (
          err instanceof JmapMethodError &&
          (err.type === "unknownMethod" || err.type === "notSupported")
        ) {
          console.info(
            `[email-connections] push unsupported on ${new URL(sessionUrl).host}; the drain covers it`,
          );
        } else {
          captureWarning("[email-connections] push setup failed", {
            connectionId: result.connection.id,
            error: err,
          });
        }
      }
      console.info("[email-connections] connected a JMAP server", {
        accountId: user.accountId,
        address: result.connection.emailAddress,
        reconnected: result.reconnected,
      });
      return Response.json({
        ok: true,
        address: result.connection.emailAddress,
        reconnected: result.reconnected,
      });
    }
    default:
      return unknownIntent();
  }
  return redirect("/emails");
}

export default function EmailsPage({ loaderData }: Route.ComponentProps) {
  const {
    oauthConfigured,
    googleConfigured,
    oauthNotice,
    userEmail,
    inboundAddress,
    inboundSenders,
    emailConnections,
    emailAccountsConfigured,
  } = loaderData;
  return (
    <PageShell
      className="emails-page"
      icon={<Mail aria-hidden="true" className="h-6 w-6" />}
      title="Email"
    >
      <EmailAccountsSection
        connections={emailConnections}
        configured={emailAccountsConfigured}
        oauthConfigured={oauthConfigured}
        googleConfigured={googleConfigured}
        oauthNotice={oauthNotice}
      />

      <Section id="receipts-by-email" title="Receipts by email">
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          Forward receipt emails to the address below and they are parsed
          (merchant, amount, category) and added automatically. The expense date
          is the date of the forwarded email.
        </p>
        {emailConnections.length === 0 && inboundSenders.length > 0 ? (
          <p className="mb-3 rounded-lg bg-blue-50 dark:bg-blue-950/40 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
            Forwarding works, but connect your Gmail or Fastmail account above
            and receipts landing in your inbox are processed automatically, no
            forwarding needed.
          </p>
        ) : null}
        <Card className="p-4">
          {inboundAddress ? (
            <div className="mb-4">
              <FieldLabel as="div" muted>
                Forward receipts to
              </FieldLabel>
              <div className="font-mono text-lg font-semibold">
                {inboundAddress}
              </div>
            </div>
          ) : (
            <StatusNote className="mb-4">
              Set the INBOUND_EMAIL_ADDRESS environment variable to show the
              forwarding address here.
            </StatusNote>
          )}
          <div className="mb-3">
            <FieldLabel as="div" className="mb-1">
              Sender addresses
            </FieldLabel>
            <StatusNote className="mb-2 text-xs">
              Receipts are imported only from <b>verified</b> addresses. Adding
              an address sends a verification link to that inbox. Once the link
              is clicked, the address is locked to your account (no one else can
              claim it) and receipts start importing.
            </StatusNote>
            <ul className="flex flex-col gap-1">
              {inboundSenders.length === 0 ? (
                <StatusNote as="li">None yet.</StatusNote>
              ) : (
                inboundSenders.map((sender) => (
                  <SenderRow
                    key={sender.address}
                    sender={sender}
                    isDefault={sender.address === userEmail}
                  />
                ))
              )}
            </ul>
          </div>
          <AddSenderForm />
        </Card>
      </Section>
    </PageShell>
  );
}
