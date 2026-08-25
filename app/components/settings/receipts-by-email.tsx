import { useEffect, useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { useFetcher } from "react-router";
import { Button } from "~/components/ui/Button";
import { Badge } from "~/components/ui/Badge";
import { Input } from "~/components/ui/Input";
import type { InboundSenderRecord } from "~/lib/types";

/**
 * One receipts-by-email sender: the address, its verified status, and
 * actions. The account's login email (the default sender) is locked: it
 * can't be removed, only verified. Unverified addresses get a Resend button
 * that emails a fresh verification link.
 */
export function SenderRow({
  sender,
  isDefault,
}: {
  sender: InboundSenderRecord;
  isDefault: boolean;
}) {
  const resendFetcher = useFetcher<{ ok: boolean; error?: string }>();
  const removeFetcher = useFetcher();
  return (
    <li className="flex flex-col gap-1 rounded-lg bg-gray-50 dark:bg-gray-900 px-3 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-sm">{sender.address}</span>
          {isDefault ? (
            <Badge tone="blue" className="shrink-0">
              Your sign-in email
            </Badge>
          ) : null}
          {sender.verified ? (
            <Badge
              tone="green"
              className="shrink-0"
              icon={<Check aria-hidden="true" className="h-3 w-3" />}
            >
              Verified
            </Badge>
          ) : (
            <Badge tone="amber" className="shrink-0">
              Awaiting verification
            </Badge>
          )}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {!sender.verified ? (
            <resendFetcher.Form method="post" className="contents">
              <input
                type="hidden"
                name="intent"
                value="resendInboundSenderVerification"
              />
              <input type="hidden" name="address" value={sender.address} />
              <button
                type="submit"
                className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                aria-label={`Resend verification email to ${sender.address}`}
              >
                Resend email
              </button>
            </resendFetcher.Form>
          ) : null}
          {!isDefault ? (
            <removeFetcher.Form method="post" className="contents">
              <input type="hidden" name="intent" value="removeInboundSender" />
              <input type="hidden" name="address" value={sender.address} />
              <button
                type="submit"
                className="text-gray-500 dark:text-gray-400 hover:text-red-600 dark:text-red-400"
                aria-label={`Remove ${sender.address}`}
              >
                <Trash2 aria-hidden="true" className="h-4 w-4" />
              </button>
            </removeFetcher.Form>
          ) : null}
        </div>
      </div>
      {resendFetcher.state !== "idle" ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Sending verification email…
        </p>
      ) : resendFetcher.data?.ok ? (
        <p className="text-xs text-green-700 dark:text-green-400">
          Verification email sent. Check that inbox and click the link.
        </p>
      ) : resendFetcher.data?.error ? (
        <p className="text-xs text-red-600 dark:text-red-400">
          {resendFetcher.data.error}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Add a new receipts-by-email sender. Adding an address only accepts
 * receipts after its mailbox owner clicks the emailed verification link, so
 * the form reports whether the verification email went out (or why not).
 */
export function AddSenderForm() {
  const fetcher = useFetcher<{
    ok: boolean;
    error?: string;
    address?: string;
  }>();
  const [address, setAddress] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const busy = fetcher.state !== "idle";

  // A successful add leaves the row in the list with its own status. Clear
  // the input; the notice carries the "email sent" confirmation.
  useEffect(() => {
    const data = fetcher.data;
    if (!data) return;
    if (data.ok && data.address) {
      setAddress("");
      setNotice({
        ok: true,
        text: `Verification email sent to ${data.address}; click the link in it and receipts from this address will start importing.`,
      });
    } else if (data.error) {
      setNotice({ ok: false, text: data.error });
    }
  }, [fetcher.data]);

  return (
    <div>
      <fetcher.Form method="post" className="flex items-center gap-2">
        <input type="hidden" name="intent" value="addInboundSender" />
        <Input
          type="email"
          name="address"
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            setNotice(null);
          }}
          placeholder="you@example.com"
          required
          aria-invalid={notice && !notice.ok ? true : undefined}
          invalid={!!notice && !notice.ok}
          className="flex-1"
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={busy || !address.trim()}
        >
          <Plus aria-hidden="true" className="h-4 w-4" />{" "}
          {busy ? "Adding…" : "Add address"}
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
          A verification email is sent to the address before receipts are
          accepted.
        </p>
      )}
    </div>
  );
}
