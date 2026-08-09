import { CheckCircle2, Clock3, ReceiptText, XCircle } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Shared shell for the two public verification-link landing pages
 * (/verify-email for account verification, /receipts-email-verify for
 * receipts-by-email sender verification). Both consume a single-use token
 * in the loader and render the same card — logo, status icon + title,
 * body copy, and a "Sign in" footer — differing only in the copy each
 * route supplies. The icon follows the status (green check, amber clock,
 * or red X) so the two pages can't drift apart visually.
 */

export type VerificationStatus =
  | "verified"
  | "already-verified"
  | "expired"
  | "invalid";

export function VerificationResultPage({
  status,
  title,
  body,
}: {
  status: VerificationStatus;
  title: string;
  body: ReactNode;
}) {
  const icon =
    status === "expired" ? (
      <Clock3 aria-hidden="true" className="h-6 w-6 text-amber-600" />
    ) : status === "invalid" ? (
      <XCircle aria-hidden="true" className="h-6 w-6 text-red-600" />
    ) : (
      <CheckCircle2 aria-hidden="true" className="h-6 w-6 text-green-600" />
    );
  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4"
    >
      <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <div className="mb-4 flex items-center justify-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-ink">
            <ReceiptText aria-hidden="true" className="h-6 w-6 text-white" />
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
