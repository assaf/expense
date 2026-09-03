import { Mail } from "lucide-react";
import { redirect } from "react-router";
import { PageShell } from "~/components/PageShell";
import { EmailAccountsSection } from "~/components/settings/email-accounts";
import {
  AddSenderForm,
  SenderRow,
} from "~/components/settings/receipts-by-email";
import { Card } from "~/components/ui/Card";
import { requireUser } from "~/lib/auth.server";
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
  createEmailConnection,
  listEmailConnections,
  readEmailConnection,
  removeEmailConnection,
} from "~/lib/db/email-connections";
import { isGmailOAuthConfigured } from "~/lib/google-oauth.server";
import { verifyJmapToken } from "~/lib/jmap.server";
import {
  encryptSecret,
  isTokenCryptoConfigured,
} from "~/lib/token-crypto.server";
import {
  connectionAccessToken,
  isFastMailOAuthConfigured,
} from "~/lib/fastmail-oauth.server";
import { destroyConnectionPushSubscription } from "~/lib/email-connection-push.server";
import { formString, unknownIntent } from "~/lib/validation";
import type { Route } from "./+types/emails";

/**
 * Email: how receipts get into Expense by email. Two features:
 *
 * 1. Connected email accounts: a user's own mailbox (FastMail via JMAP) whose
 *    receipts are imported automatically (expense added, email moved to
 *    Trash, and a reply with an edit link lands in the inbox).
 * 2. Receipts by email: a dedicated forward-to address; forwarding a receipt
 *    email there parses and adds it (only from verified sender addresses).
 */

const OAUTH_ERROR_TEXT: Record<string, string> = {
  state: "The FastMail connection attempt expired or did not match; try again.",
  denied: "FastMail consent was not granted; nothing was connected.",
  exchange: "FastMail could not exchange the authorization; try again.",
  verify:
    "FastMail approved the connection but the token failed verification; try again.",
  unconfigured:
    "Connecting with FastMail is not configured on this deployment.",
};

const GMAIL_OAUTH_ERROR_TEXT: Record<string, string> = {
  state: "The Gmail connection attempt expired or did not match; try again.",
  denied: "Gmail consent was not granted; nothing was connected.",
  exchange: "Google could not exchange the authorization; try again.",
  verify:
    "Google approved the connection but the Gmail check failed; try again.",
  unconfigured: "Connecting with Gmail is not configured on this deployment.",
};

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
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
          text: `${params.get("address") ?? "The mailbox"} connected; expenses will import automatically.`,
        }
      : { ok: false, text: params.get("reason") ?? "Could not connect." }
    : oauthError
      ? {
          ok: false,
          text: OAUTH_ERROR_TEXT[oauthError] ?? "Could not connect.",
        }
      : gmailOauthError
        ? {
            ok: false,
            text:
              GMAIL_OAUTH_ERROR_TEXT[gmailOauthError] ?? "Could not connect.",
          }
        : null;
  return {
    userEmail: user.email,
    inboundAddress: INBOUND_EMAIL_ADDRESS,
    inboundSenders,
    emailConnections,
    emailAccountsConfigured: isTokenCryptoConfigured(),
    oauthConfigured: isFastMailOAuthConfigured(),
    googleConfigured: isGmailOAuthConfigured(),
    oauthNotice,
  };
}

export function meta(): Route.MetaDescriptors {
  return [{ title: "Email — Expense" }];
}

export async function action({ request }: Route.ActionArgs) {
  const { user, form, intent } = await requireIntent(request);

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
  // was already verified for this account; nothing to send.
  const finishSender = async (
    result:
      | { ok: true; address: string; token: string | null }
      | { ok: false; error: string },
  ) => {
    if (!result.ok) return Response.json(result);
    if (result.token) await sendVerification(result.address, result.token);
    return Response.json({ ok: true, address: result.address });
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
    case "connectEmail": {
      if (!isTokenCryptoConfigured()) {
        return Response.json(
          {
            ok: false,
            error:
              "Email account connections are not configured on this deployment.",
          },
          { status: 503 },
        );
      }
      const token = formString(form, "token").trim();
      if (!token) {
        return Response.json({
          ok: false,
          error: "Paste your API token first.",
        });
      }
      const verification = await verifyJmapToken(token);
      if (!verification.ok) {
        return Response.json({ ok: false, error: verification.message });
      }
      const result = await createEmailConnection({
        accountId: user.accountId,
        provider: "fastmail",
        emailAddress: verification.info.username,
        remoteAccountId: verification.info.mailAccountId,
        tokenEnc: encryptSecret(token),
      });
      if (!result.ok) return Response.json(result);
      console.info("[email-connections] connected", {
        accountId: user.accountId,
        address: result.connection.emailAddress,
      });
      return Response.json({
        ok: true,
        address: result.connection.emailAddress,
      });
    }
    case "disconnectEmail": {
      const id = formString(form, "id");
      const connection = await readEmailConnection(user.accountId, id);
      if (connection) {
        // Best effort: tear down the server-side push subscription with
        // the user's token. A failure (revoked token, FastMail down) still
        // disconnects. The orphaned subscription dies at expiry and its
        // pushes hit the webhook's unknown-connection path.
        try {
          const token = await connectionAccessToken(connection);
          if (connection.pushSubscriptionId) {
            await destroyConnectionPushSubscription(
              token,
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

      <section id="receipts-by-email" className="mb-8 scroll-mt-6">
        <h2 className="mb-2 text-lg font-semibold">Receipts by email</h2>
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          Forward receipt emails to the address below and they are parsed
          (merchant, amount, category) and added automatically. The expense date
          is the date of the forwarded email.
        </p>
        {emailConnections.length === 0 && inboundSenders.length > 0 ? (
          <p className="mb-3 rounded-lg bg-blue-50 dark:bg-blue-950/40 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
            Forwarding works, but connect your Gmail or FastMail account above
            and receipts landing in your inbox are processed automatically, no
            forwarding needed.
          </p>
        ) : null}
        <Card className="p-4">
          {inboundAddress ? (
            <div className="mb-4">
              <div className="text-sm font-medium text-gray-500 dark:text-gray-400">
                Forward receipts to
              </div>
              <div className="font-mono text-lg font-semibold">
                {inboundAddress}
              </div>
            </div>
          ) : (
            <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
              Set the INBOUND_EMAIL_ADDRESS environment variable to show the
              forwarding address here.
            </p>
          )}
          <div className="mb-3">
            <div className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-200">
              Sender addresses
            </div>
            <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
              Receipts are imported only from <b>verified</b> addresses. Adding
              an address sends a verification link to that inbox. Once the link
              is clicked, the address is locked to your account (no one else can
              claim it) and receipts start importing.
            </p>
            <ul className="flex flex-col gap-1">
              {inboundSenders.length === 0 ? (
                <li className="text-sm text-gray-500 dark:text-gray-400">
                  None yet.
                </li>
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
      </section>
    </PageShell>
  );
}
