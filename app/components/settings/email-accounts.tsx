import { useEffect, useState } from "react";
import { Plug, PlugZap, Trash2 } from "lucide-react";
import { useFetcher } from "react-router";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { formatShortDate } from "~/lib/format";
import type { EmailConnectionView } from "~/lib/db/email-connections";

/**
 * Settings → Email accounts: connect a user's own mailbox for automatic
 * expense import. Today FastMail-only (JMAP): the connect flow walks the
 * user through generating an API token in FastMail, verifies it live, and
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
}: {
  connections: EmailConnectionView[];
  configured: boolean;
}) {
  return (
    <section id="email-accounts" className="mb-8 scroll-mt-6">
      <h2 className="mb-2 text-lg font-semibold">Email accounts</h2>
      <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
        Connect an email account and receipts in it are imported automatically —
        the expense is added, the email is moved to Trash, and a reply with an
        edit link lands in your inbox.
      </p>
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
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
            <ConnectForm />
          </>
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Email account connections are not configured on this deployment
            (missing <code>EMAIL_TOKEN_ENCRYPTION_KEY</code>).
          </p>
        )}
      </div>
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
          <span className="shrink-0 rounded-full bg-blue-100 dark:bg-gray-700 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-400 capitalize">
            {connection.provider}
          </span>
          {connection.status === "error" ? (
            <span className="shrink-0 rounded-full bg-red-100 dark:bg-red-900/40 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400">
              Needs attention
            </span>
          ) : null}
        </span>
        <disconnectFetcher.Form method="post" className="contents">
          <input type="hidden" name="intent" value="disconnectEmail" />
          <input type="hidden" name="id" value={connection.id} />
          <button
            type="submit"
            disabled={busy}
            className="text-gray-500 dark:text-gray-400 hover:text-red-600 dark:text-red-400 disabled:opacity-50"
            aria-label={`Disconnect ${connection.emailAddress}`}
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
          </button>
        </disconnectFetcher.Form>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {connection.receivedCount} received · {connection.processedCount}{" "}
        processed · {connection.processedLast24h} in the last 24h · last webhook{" "}
        {formatShortDate(connection.lastPushAt)} · connected{" "}
        {formatShortDate(connection.createdAt)}
      </p>
      {busy ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Disconnecting…
        </p>
      ) : null}
    </li>
  );
}

function ConnectForm() {
  const fetcher = useFetcher<ConnectResult>();
  const [token, setToken] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    const data = fetcher.data;
    if (!data) return;
    if (data.ok && data.address) {
      setToken("");
      setNotice({
        ok: true,
        text: `${data.address} connected — expenses will import automatically.`,
      });
    } else if (data.error) {
      setNotice({ ok: false, text: data.error });
    }
  }, [fetcher.data]);

  return (
    <div className="mt-4 border-t border-gray-200 dark:border-gray-700 pt-4">
      <div className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-200">
        Connect a FastMail account
      </div>
      <ol className="mb-2 list-decimal space-y-0.5 pl-5 text-xs text-gray-500 dark:text-gray-400">
        <li>
          Open{" "}
          <a
            href="https://app.fastmail.com/settings/security/tokens/new"
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 dark:text-blue-400 hover:underline"
          >
            FastMail → Settings → Privacy &amp; Security → API tokens
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
          placeholder="Paste your FastMail API token"
          autoComplete="off"
          required
          aria-invalid={notice && !notice.ok ? true : undefined}
          invalid={!!notice && !notice.ok}
          className="flex-1"
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
          The token is verified with FastMail and stored encrypted. You can
          revoke it any time in FastMail, or disconnect it here.
        </p>
      )}
    </div>
  );
}
