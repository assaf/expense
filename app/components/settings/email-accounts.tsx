import { useState } from "react";
import { ArrowRight, Mail, Plug, PlugZap } from "lucide-react";
import { useFetcherNotice } from "~/components/settings/use-fetcher-notice";
import { Link, useFetcher } from "react-router";
import { RemoveButton } from "~/components/settings/name-list";
import { Button } from "~/components/ui/Button";
import { OrDivider } from "~/components/ui/OrDivider";
import { Card } from "~/components/ui/Card";
import { Badge } from "~/components/ui/Badge";
import { Input } from "~/components/ui/Input";
import { LocalDate } from "~/components/ui/LocalTime";
import type { EmailConnectionView } from "~/lib/db/email-connections";

/**
 * Email page → Email accounts: connect a user's own mailbox for automatic
 * expense import. Today Fastmail-only (JMAP): the connect flow walks the
 * user through generating an API token in Fastmail, verifies it live, and
 * stores it encrypted. Each connected mailbox shows its health stats
 * (received / processed / last-24h / last webhook) and a disconnect button.
 */

interface ConnectResult {
  ok: boolean;
  error?: string;
  address?: string;
}

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
    <section id="email-accounts" className="mb-8 scroll-mt-6">
      <h2 className="mb-2 text-lg font-semibold">Email accounts</h2>
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
                <li className="text-sm text-gray-500 dark:text-gray-400">
                  No email accounts connected yet.
                </li>
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
            <ConnectForm
              oauthConfigured={oauthConfigured}
              googleConfigured={googleConfigured}
            />
          </>
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Email account connections are not configured on this deployment
            (missing <code>EMAIL_TOKEN_ENCRYPTION_KEY</code>).
          </p>
        )}
      </Card>
    </section>
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

function ConnectForm({
  oauthConfigured,
  googleConfigured,
}: {
  oauthConfigured: boolean;
  googleConfigured: boolean;
}) {
  const fetcher = useFetcher<ConnectResult>();
  const [token, setToken] = useState("");
  const busy = fetcher.state !== "idle";
  const { notice, setNotice } = useFetcherNotice(
    fetcher.data,
    (address) => `${address} connected; expenses will import automatically.`,
    () => setToken(""),
  );

  return (
    <div className="mt-4 border-t border-gray-200 dark:border-gray-700 pt-4">
      {googleConfigured ? (
        <>
          <Button asChild size="md" className="w-full">
            <a href="/connect-gmail?next=emails">
              <Mail aria-hidden="true" className="h-4 w-4" />
              Connect with Gmail
            </a>
          </Button>
          <div className="my-4">
            <OrDivider />
          </div>
        </>
      ) : null}
      <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
        Connect your Fastmail
      </h3>
      {oauthConfigured ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button asChild size="sm">
            <a href="/connect-fastmail?next=emails">
              <Plug aria-hidden="true" className="h-4 w-4" />
              Connect with Fastmail
            </a>
          </Button>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            or paste an API token
          </p>
        </div>
      ) : null}
      <ol className="mb-2 list-decimal space-y-0.5 pl-5 text-xs text-gray-500 dark:text-gray-400">
        <li>
          Open{" "}
          <a
            href="https://app.fastmail.com/settings/security/tokens/new"
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 dark:text-blue-400 hover:underline"
          >
            Fastmail → Settings → Privacy &amp; Security → API tokens
            <PlugZap
              aria-hidden="true"
              className="ml-0.5 inline h-3 w-3 align-text-bottom"
            />
          </a>{" "}
          (log in first).
        </li>
        <li>
          Create a token named “Expense” with <b>Read mail</b> and{" "}
          <b>Compose</b> scopes.
        </li>
        <li>Copy the token and paste it below.</li>
      </ol>
      <fetcher.Form method="post" className="flex items-center gap-2">
        <input type="hidden" name="intent" value="connectEmail" />
        <Input
          type="password"
          name="token"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setNotice(null);
          }}
          placeholder="Paste your Fastmail API token"
          autoComplete="off"
          required
          aria-invalid={notice && !notice.ok ? true : undefined}
          invalid={!!notice && !notice.ok}
          className="min-w-0 flex-1"
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={busy || !token.trim()}
        >
          {busy ? "Verifying…" : "Connect"}
        </Button>
      </fetcher.Form>
      {notice ? (
        <p
          role="status"
          className={`mt-1 text-xs ${notice.ok ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
        >
          {notice.text}
        </p>
      ) : (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          The token is verified with Fastmail and stored encrypted; OAuth
          connections are stored encrypted too. You can revoke either any time
          in Gmail or Fastmail, or disconnect it here.
        </p>
      )}
    </div>
  );
}
