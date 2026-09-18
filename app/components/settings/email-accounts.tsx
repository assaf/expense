import { ArrowRight, Mail, Plug, PlugZap } from "lucide-react";
import { Link, useFetcher } from "react-router";
import { Button } from "~/components/ui/Button";
import { OrDivider } from "~/components/ui/OrDivider";
import { Card } from "~/components/ui/Card";
import { Badge } from "~/components/ui/Badge";
import { LocalDate } from "~/components/ui/LocalTime";
import { RemoveButton } from "~/components/ui/RemoveButton";
import { Section } from "~/components/ui/Section";
import { StatusNote } from "~/components/ui/StatusNote";
import type { EmailConnectionView } from "~/lib/db/email-connections";

/**
 * Email page → Email accounts: connect a user's own mailbox for automatic
 * expense import. Connecting runs the provider's OAuth flow (Fastmail over
 * JMAP, Gmail over the Gmail API) and the tokens are stored encrypted;
 * nothing is pasted by hand. Each connected mailbox shows its health stats
 * (received / processed / last-24h / last webhook) and a disconnect button.
 */

export function EmailAccountsSection({
  connections,
  configured,
  oauthConfigured,
  googleConfigured,
  oauthNotice,
}: {
  connections: EmailConnectionView[];
  configured: boolean;
  /** FASTMAIL_OAUTH_CLIENT_ID is set (resolved server-side in the loader;
   * env.ts never runs in the browser). */
  oauthConfigured: boolean;
  /** The GOOGLE_* vars are set (resolved server-side in the loader). */
  googleConfigured: boolean;
  /** Landing notice from an OAuth callback redirect (connected=0/1 or
   * oauthError/gmailOauthError params). */
  oauthNotice: { ok: boolean; text: string } | null;
}) {
  return (
    <Section id="email-accounts" title="Email accounts">
      <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
        Connect an email account and receipts in it are imported automatically —
        the expense is added, the email is moved to Trash, and a reply with an
        edit link lands in your inbox. Newly connected?{" "}
        <Link
          to={`/email-review?connection=${connections[0]?.id ?? ""}`}
          className="text-blue-600 underline underline-offset-2 dark:text-blue-400"
        >
          Review your inbox
        </Link>{" "}
        to go through the receipts already there.
      </p>
      <Card className="p-4">
        {configured ? (
          <>
            <ul className="flex flex-col gap-2">
              {connections.length === 0 ? (
                <StatusNote as="li">
                  No email accounts connected yet.
                </StatusNote>
              ) : (
                connections.map((connection) => (
                  <ConnectionRow key={connection.id} connection={connection} />
                ))
              )}
            </ul>
            {oauthNotice ? (
              <p
                role="status"
                className={`mb-2 text-xs ${oauthNotice.ok ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
              >
                {oauthNotice.text}
              </p>
            ) : null}
            <ConnectButtons
              oauthConfigured={oauthConfigured}
              googleConfigured={googleConfigured}
            />
          </>
        ) : (
          <StatusNote>
            Email account connections are not configured on this deployment
            (missing <code>EMAIL_TOKEN_ENCRYPTION_KEY</code>).
          </StatusNote>
        )}
      </Card>
    </Section>
  );
}

function ConnectionRow({ connection }: { connection: EmailConnectionView }) {
  const disconnectFetcher = useFetcher();
  const busy = disconnectFetcher.state !== "idle";
  return (
    <li className="flex flex-col gap-1 rounded-lg bg-gray-50 dark:bg-gray-900 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <Plug
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400"
          />
          <span className="truncate font-mono text-sm">
            {connection.emailAddress}
          </span>
          <Badge tone="blue" className="shrink-0 capitalize">
            {connection.provider}
          </Badge>
          {connection.status === "error" ? (
            <Badge tone="red" className="shrink-0">
              Needs attention
            </Badge>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link
              to={`/email-review?connection=${connection.id}`}
              aria-label={`Review inbox for ${connection.emailAddress}`}
            >
              Review{" "}
              {connection.pendingReview > 0 ? (
                <Badge tone="blue" className="px-1.5 font-semibold">
                  {connection.pendingReview}
                </Badge>
              ) : null}
              <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
            </Link>
          </Button>
          <RemoveButton
            fetcher={disconnectFetcher}
            intent="disconnectEmail"
            fields={{ id: connection.id }}
            label={`Disconnect ${connection.emailAddress}`}
            disabled={busy}
          />
        </span>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {connection.receivedCount} received · {connection.processedCount}{" "}
        processed · {connection.processedLast24h} in the last 24h · last webhook{" "}
        <LocalDate iso={connection.lastPushAt} /> · connected{" "}
        <LocalDate iso={connection.createdAt} />
      </p>
      {busy ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Disconnecting…
        </p>
      ) : null}
    </li>
  );
}

/** The connect entry points: one button per configured provider, or a note
 * when this deployment has no provider OAuth client. Connecting runs the
 * provider's OAuth flow; nothing is pasted by hand. */
function ConnectButtons({
  oauthConfigured,
  googleConfigured,
}: {
  oauthConfigured: boolean;
  googleConfigured: boolean;
}) {
  return (
    <div className="mt-4 border-t border-gray-200 pt-4 dark:border-gray-700">
      {googleConfigured ? (
        <>
          <Button asChild size="md" className="w-full">
            <a href="/connect-gmail?next=emails">
              <Mail aria-hidden="true" className="h-4 w-4" />
              Connect with Gmail
            </a>
          </Button>
          {oauthConfigured ? (
            <div className="my-4">
              <OrDivider />
            </div>
          ) : null}
        </>
      ) : null}
      {oauthConfigured ? (
        <Button asChild size="md" className="w-full">
          <a href="/connect-fastmail?next=emails">
            <PlugZap aria-hidden="true" className="h-4 w-4" />
            Connect with Fastmail
          </a>
        </Button>
      ) : null}
      {!oauthConfigured && !googleConfigured ? (
        <StatusNote>
          No provider is configured for connecting a mailbox on this deployment.
        </StatusNote>
      ) : null}
    </div>
  );
}
