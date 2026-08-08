import {
  Bot,
  CreditCard,
  FileText,
  Fuel,
  Mail,
  MapPinned,
  ReceiptText,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "~/components/ui/Button";

/**
 * One rotating "did you know?" card at the bottom of the home page. The
 * loader picks a highlight id at random from the ones that can render with
 * the current data (e.g. "email" needs the inbound address configured), so
 * every return visit surfaces a different feature without the card ever
 * getting in the way of adding expenses.
 */

export type HighlightId =
  | "capture"
  | "email"
  | "mcp"
  | "mileage-location"
  | "mileage-rate"
  | "reports"
  | "invite"
  | "reconcile";

/** The data a highlight may interpolate. Fields the app doesn't have are
 * empty strings — the matching highlights are excluded from the pool. */
export interface HighlightData {
  inboundAddress: string;
  mcpUrl: string;
  inviteCode: string;
  mileageRate: string;
}

interface HighlightDef {
  icon: LucideIcon;
  title: string;
  body: (data: HighlightData) => ReactNode;
  cta: { label: string; to: string };
}

const HIGHLIGHTS: Record<HighlightId, HighlightDef> = {
  capture: {
    icon: ReceiptText,
    title: "Add a receipt without typing",
    body: () => (
      <>
        Upload or paste (⌘V) a receipt image or PDF — or drag one anywhere on
        this page. Merchant, amount, and category fill in automatically.
      </>
    ),
    cta: { label: "Add a receipt", to: "/expense/new" },
  },
  email: {
    icon: Mail,
    title: "Email your receipts",
    body: (data) => (
      <>
        Forward a receipt email to{" "}
        <span className="break-all font-mono font-semibold text-gray-700">
          {data.inboundAddress}
        </span>{" "}
        and it is added automatically — PDF and image attachments supported.
        Only emails from verified sender addresses are imported; add yours in
        Settings.
      </>
    ),
    cta: { label: "Manage email addresses", to: "/settings" },
  },
  mcp: {
    icon: Bot,
    title: "Let your AI assistant lend a hand",
    body: (data) => (
      <>
        Point any MCP client — Claude, OpenAI, or another assistant — at{" "}
        <span className="break-all font-mono font-semibold text-gray-700">
          {data.mcpUrl}
        </span>
        . It can capture receipts, log mileage, answer spending questions, and
        export reports. Revoke access to any app in Settings.
      </>
    ),
    cta: { label: "Manage connected apps", to: "/settings" },
  },
  "mileage-location": {
    icon: MapPinned,
    title: "Mileage measured from where you start",
    body: () => (
      <>
        Set a start/end location — home, office, or wherever you choose — and
        every drive is measured as a round trip from there. Change it anytime in
        Settings.
      </>
    ),
    cta: { label: "Set your location", to: "/settings" },
  },
  "mileage-rate": {
    icon: Fuel,
    title: "Mileage rates come from the IRS",
    body: (data) => (
      <>
        Rates update automatically from the IRS —{" "}
        <span className="font-semibold text-gray-700">
          ${data.mileageRate}/mi
        </span>{" "}
        for business right now. Classify each drive as business, charity, or
        medical and the right rate is applied.
      </>
    ),
    cta: { label: "Log a drive", to: "/expense/new?type=mileage" },
  },
  reports: {
    icon: FileText,
    title: "Reports for every filing",
    body: () => (
      <>
        Create as many reports as you need and export any of them as a PDF.
        Close the ones you have filed, or delete ones you no longer use — all
        from Settings.
      </>
    ),
    cta: { label: "Manage reports", to: "/settings" },
  },
  invite: {
    icon: Users,
    title: "Bring your accountant or family in",
    body: (data) => (
      <>
        Share your invite code{" "}
        <span className="break-all font-mono font-semibold text-gray-700">
          {data.inviteCode}
        </span>{" "}
        and they can join your account — everyone sees the same expenses,
        reports, and settings.
      </>
    ),
    cta: { label: "Get your invite code", to: "/settings" },
  },
  reconcile: {
    icon: CreditCard,
    title: "Reconcile against your statement",
    body: () => (
      <>
        Upload a credit card statement — PDF, QuickBooks, CSV, or Excel — and
        Expense matches it against your logged expenses. Catch deductions you
        missed and find discrepancies.
      </>
    ),
    cta: { label: "Reconcile now", to: "/reconcile" },
  },
};

/** The highlight ids that can render with the given data: "email" needs the
 * inbound address configured, "mileage-rate" a published IRS rate, "invite"
 * the account's invite code. "capture" is always available, so the pool is
 * never empty. */
export function availableHighlights(data: HighlightData): HighlightId[] {
  const pool: HighlightId[] = [
    "capture",
    "mileage-location",
    "reports",
    "reconcile",
  ];
  if (data.inboundAddress) pool.push("email");
  if (data.mcpUrl) pool.push("mcp");
  if (data.mileageRate) pool.push("mileage-rate");
  if (data.inviteCode) pool.push("invite");
  return pool;
}

/** Pick one highlight at random from the ones the current data can render. */
export function pickHighlight(data: HighlightData): HighlightId {
  const pool = availableHighlights(data);
  return pool[Math.floor(Math.random() * pool.length)]!;
}

export function FeatureHighlight({
  id,
  data,
}: {
  id: HighlightId;
  data: HighlightData;
}) {
  const { icon: Icon, title, body, cta } = HIGHLIGHTS[id];
  return (
    <aside className="mt-6 rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
            Did you know?
          </p>
          <p className="text-sm font-semibold text-gray-800">{title}</p>
          <p className="mt-1 text-sm text-gray-500">{body(data)}</p>
        </div>
      </div>
      <div className="mt-3 pl-12">
        <Button asChild variant="secondary" size="sm">
          <Link to={cta.to}>{cta.label}</Link>
        </Button>
      </div>
    </aside>
  );
}
