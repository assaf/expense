import { CheckCircle2, Clock3, ReceiptText, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import {
  verifyUserEmailAddress,
  type VerifyEmailOutcome,
} from "~/lib/store.server";
import type { Route } from "./+types/verify-email";

/**
 * Public landing page for account-verification links (emailed after
 * signup/join). No session — anyone with the token can verify, which is
 * the point: only the mailbox owner has the link. The loader consumes the
 * single-use token and marks the user's email verified, after which they
 * can sign in. Refreshing a used link reports "already verified" (the
 * token hash is kept after success); a token from a replaced account
 * (re-signup while unverified) is invalid — the old link is discarded.
 */

export async function loader({
  request,
}: Route.LoaderArgs): Promise<VerifyEmailOutcome> {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  return verifyUserEmailAddress(token);
}

export default function VerifyEmailPage({ loaderData }: Route.ComponentProps) {
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
            <b className="font-mono">{outcome.email}</b> is verified. You can
            now sign in to Expense.
          </p>
          <p>Receipts by email for this address were also set up at signup.</p>
        </>
      );
      break;
    case "already-verified":
      icon = <CheckCircle2 className="h-6 w-6 text-green-600" aria-hidden />;
      title = "Already verified";
      body = (
        <>
          <p>
            <b className="font-mono">{outcome.email}</b> was already verified.
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
            Sign in with your email and password and use the{" "}
            <b>Resend verification email</b> button to get a fresh link.
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
            The link may have been used already, copied incorrectly, or the
            account was re-created since it was sent (which discards the old
            link).
          </p>
          <p>
            Sign in with your email and password and use the{" "}
            <b>Resend verification email</b> button to get a fresh link.
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
