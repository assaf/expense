import { CheckCircle2, Clock3, ReceiptText, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { INBOUND_EMAIL_ADDRESS } from "~/lib/env";
import { verifyInboundSenderAddress } from "~/lib/store.server";
import type { Route } from "./+types/receipts-email-verify";

/**
 * Public landing page for receipts-by-email verification links (emailed to
 * the sender address). No session — anyone with the token can verify, which
 * is the point: only the mailbox owner has the link. The loader consumes the
 * single-use token and claims the address for its account; the page reports
 * the outcome. Refreshing after a successful click shows the "already used"
 * state, which is honest (the address is verified).
 */

export async function loader({ request }: Route.LoaderArgs) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const outcome = await verifyInboundSenderAddress(token);
  // The forward-to address, so the page states the same sentence the email
  // does ("Receipts forwarded from X to Y will be added to …") — the user can
  // read it in the email and copy the same details from the page.
  return { ...outcome, forwardTo: INBOUND_EMAIL_ADDRESS };
}

export default function VerifySenderPage({ loaderData }: Route.ComponentProps) {
  const outcome = loaderData;
  let icon: ReactNode;
  let title: string;
  let body: ReactNode;
  switch (outcome.status) {
    case "verified":
      icon = <CheckCircle2 className="h-6 w-6 text-green-600" aria-hidden />;
      title = "Email verified";
      body = (
        <>
          <p>
            Receipts forwarded from{" "}
            <b className="font-mono">{outcome.address}</b> to{" "}
            <b className="font-mono">{outcome.forwardTo}</b> will be added to
            the <b>{outcome.accountName}</b> account on Expense.
          </p>
          <p>
            No other account can use this address anymore. Forward a receipt to
            the expense email to try it out.
          </p>
        </>
      );
      break;
    case "already-verified":
      icon = <CheckCircle2 className="h-6 w-6 text-green-600" aria-hidden />;
      title = "Already verified";
      body = (
        <>
          <p>
            Receipts forwarded from{" "}
            <b className="font-mono">{outcome.address}</b> to{" "}
            <b className="font-mono">{outcome.forwardTo}</b> will be added to
            the <b>{outcome.accountName}</b> account on Expense.
          </p>
          <p>This link has already been used. No further action is needed.</p>
        </>
      );
      break;
    case "expired":
      icon = <Clock3 className="h-6 w-6 text-amber-600" aria-hidden />;
      title = "This verification link has expired";
      body = (
        <>
          <p>
            Verification links last 7 days, and this one was sent more than that
            ago.
          </p>
          <p>
            Sign in to Expense, go to <b>Settings → Receipts by email</b>, and
            click <b>Resend email</b> next to{" "}
            <b className="font-mono">{outcome.address}</b>.
          </p>
        </>
      );
      break;
    default:
      icon = <XCircle className="h-6 w-6 text-red-600" aria-hidden />;
      title = "This verification link is not valid";
      body = (
        <>
          <p>
            The link may have been used already, copied incorrectly, or not sent
            at all.
          </p>
          <p>
            Sign in to Expense, go to <b>Settings → Receipts by email</b>, and
            click <b>Resend email</b> to get a fresh link.
          </p>
        </>
      );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <div className="mb-4 flex items-center justify-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-ink">
            <ReceiptText className="h-6 w-6 text-white" />
          </div>
        </div>
        <div className="mb-3 flex items-center justify-center gap-2">
          {icon}
          <h1 className="text-lg font-bold">{title}</h1>
        </div>
        <div className="flex flex-col gap-2 text-sm text-gray-600">{body}</div>
        <div className="mt-6 border-t border-gray-100 pt-4 text-sm">
          <a
            href="/login"
            className="font-medium text-blue-600 hover:underline"
          >
            Sign in to Expense
          </a>
        </div>
      </div>
    </main>
  );
}
