import { KeyRound } from "lucide-react";
import { useFetcher } from "react-router";
import { RemoveButton } from "~/components/settings/name-list";
import { Card } from "~/components/ui/Card";
import { formatShortDate } from "~/lib/format";

/**
 * Agents & API (MCP): the OAuth-connected apps for this account. Each app
 * shows its name, client id, when it was last used, and when its access
 * expires; the remove button revokes every token for the app and drops the
 * consent. (Tokens are managed as a whole per app; no individual rows.)
 */
export function AgentsSection({
  oauthSessions,
  mcpUrl,
}: {
  oauthSessions: {
    client: { id: string; name: string };
    lastUsedAt: string | null;
    expiresAt: string | null;
  }[];
  mcpUrl: string;
}) {
  const removeFetcher = useFetcher<{ ok: boolean }>();

  return (
    <section id="agents" className="mb-8 scroll-mt-6">
      <h2 className="mb-2 text-lg font-semibold">Agents &amp; API (MCP)</h2>
      <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
        Connect your AI assistant (Claude, OpenAI, or any MCP client) to this
        account. Point the client at the endpoint below and approve the
        connection in your browser by signing in. Agents can capture receipts,
        log mileage, answer “how much did I spend on …?”, build and export
        reports, and reconcile bank statements against logged expenses.
      </p>
      <Card className="p-4">
        <div className="mb-4">
          <div className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-200">
            Endpoint
          </div>
          <div className="font-mono text-sm text-gray-600 dark:text-gray-300">
            {mcpUrl}
          </div>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Point your MCP client here; it discovers the sign-in flow
            automatically.
          </p>
        </div>

        <div>
          <div className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-200">
            Connected apps
          </div>
          {oauthSessions.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              None yet. The first time an assistant connects, you approve it
              here by signing in.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {oauthSessions.map(({ client, lastUsedAt, expiresAt }) => (
                <li
                  key={client.id}
                  className="rounded-lg bg-gray-50 dark:bg-gray-900 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <KeyRound
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400"
                      />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {client.name}
                        </div>
                        <div className="truncate font-mono text-xs text-gray-500 dark:text-gray-400">
                          {client.id}
                        </div>
                      </div>
                    </div>
                    <RemoveButton
                      fetcher={removeFetcher}
                      intent="disconnectOAuthClient"
                      fields={{ clientId: client.id }}
                      label={`Remove ${client.name}`}
                      title={`Remove ${client.name}`}
                      className="shrink-0"
                    />
                  </div>
                  <p className="mt-1 border-t border-gray-200 dark:border-gray-700 pl-8 pt-1.5 text-xs text-gray-500 dark:text-gray-400">
                    {expiresAt
                      ? `Last used ${formatShortDate(lastUsedAt)} · expires ${formatShortDate(expiresAt)}`
                      : `Last used ${formatShortDate(lastUsedAt)} · no active tokens`}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            Removing an app revokes its access tokens immediately and stops it
            from connecting again; it can reconnect by signing in again.
          </p>
        </div>
      </Card>
    </section>
  );
}
