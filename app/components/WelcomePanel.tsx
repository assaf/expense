import { useEffect, useState } from "react";
import { Inbox, Mail, MapPinned, ReceiptText, X } from "lucide-react";
import { Link, useFetcher } from "react-router";
import { Button } from "~/components/ui/Button";

/**
 * One-time welcome panel shown on the expense list after FastMail
 * onboarding finishes. Introduces the features the user hasn't seen yet;
 * dismissing it writes the `onboardingDone` setting so it never returns.
 * `inboundAddress` comes from the loader — `~/lib/env` is server-only and
 * must never be imported from a client component.
 */

export function WelcomePanel({ inboundAddress }: { inboundAddress: string }) {
  const fetcher = useFetcher();
  const [hidden, setHidden] = useState(false);
  const busy = fetcher.state !== "idle";

  // The dismiss action returns null — hide as soon as it settles, so the
  // panel doesn't linger until the next page load.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data !== undefined) {
      setHidden(true);
    }
  }, [fetcher.state, fetcher.data]);

  if (hidden) return null;

  return (
    <section
      aria-label="Welcome"
      className="mb-6 rounded-xl border border-blue-200 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-950/40 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-gray-900 dark:text-gray-100">
            You're all set — your inbox is connected
          </h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            Receipts from your mailbox now import automatically. Everything else
            you can do from here:
          </p>
        </div>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="welcomeDone" />
          <button
            type="submit"
            disabled={busy}
            aria-label="Dismiss welcome message"
            className="rounded-full p-1.5 text-gray-500 dark:text-gray-400 transition-colors hover:bg-blue-100 dark:hover:bg-blue-900/60 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-50"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </fetcher.Form>
      </div>
      <ul className="mt-3 grid gap-1.5 text-sm text-gray-700 dark:text-gray-200 sm:grid-cols-2">
        <li className="flex items-center gap-2">
          <Inbox
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
          />
          <span>New receipts found in your inbox land here automatically.</span>
        </li>
        <li className="flex items-center gap-2">
          <Mail
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
          />
          <span>
            Forward any receipt email to{" "}
            <span className="font-mono text-xs">{inboundAddress}</span> — the
            app adds it for you.
          </span>
        </li>
        <li className="flex items-center gap-2">
          <MapPinned
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
          />
          <span>Log mileage drives with routed maps and IRS rates.</span>
        </li>
        <li className="flex items-center gap-2">
          <ReceiptText
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
          />
          <span>Reconcile against your card statement and export reports.</span>
        </li>
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button asChild size="sm">
          <Link to="/expense/new">Add a receipt</Link>
        </Button>
        <Button asChild variant="secondary" size="sm">
          <Link to="/reconcile">Reconcile a statement</Link>
        </Button>
        <Button asChild variant="secondary" size="sm">
          <Link to="/emails">Email settings</Link>
        </Button>
      </div>
    </section>
  );
}
