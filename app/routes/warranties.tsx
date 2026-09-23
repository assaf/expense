import { Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { PageShell } from "~/components/PageShell";
import { Alert } from "~/components/ui/Alert";
import { Badge } from "~/components/ui/Badge";
import { Button } from "~/components/ui/Button";
import { Card } from "~/components/ui/Card";
import { EmptyState } from "~/components/ui/EmptyState";
import { LiveStatus } from "~/components/ui/LiveStatus";
import { Section } from "~/components/ui/Section";
import { useFlashRow } from "~/components/ui/ListRow";
import { requireContextUser } from "~/lib/auth.server";
import { readWarranties } from "~/lib/db/warranties";
import { isReceiptFile } from "~/lib/file-types";
import { formatAmount, formatDate } from "~/lib/format";
import { useDropTarget } from "~/lib/use-drop-target";
import { useToday } from "~/lib/use-today";
import {
  EXPIRING_SOON_DAYS,
  warrantyExpiryBadge,
  warrantyExpiryGroup,
  type WarrantyExpiryGroup,
} from "~/lib/warranty-expiry";
import type { Warranty } from "~/lib/types";
import type { Route } from "./+types/warranties";

/** The list page: one account's warranties, grouped by how close the
 * expiry is. */
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireContextUser(context, request);
  const warranties = await readWarranties(user.accountId);
  return { warranties };
}

export function meta(): Route.MetaDescriptors {
  return [{ title: "Warranties — Expense" }];
}

/** The groups in the order they render. Grouping itself is client-side: a
 * server-side "today" is tomorrow for a PST user after 4pm. */
const GROUPS: Array<{ key: WarrantyExpiryGroup; title: string }> = [
  { key: "soon", title: `Expiring within ${EXPIRING_SOON_DAYS} days` },
  { key: "later", title: "Expiring later" },
  { key: "none", title: "No expiration date" },
  { key: "expired", title: "Already expired" },
];

function documentCountLabel(count: number): string {
  return `${count} document${count === 1 ? "" : "s"}`;
}

export default function WarrantiesPage({ loaderData }: Route.ComponentProps) {
  return <WarrantyList warranties={loaderData.warranties} />;
}

function WarrantyList({ warranties }: { warranties: Warranty[] }) {
  // Browser-local today; null until mounted, which is why the grouping (and
  // the badge wording) only happens afterwards.
  const today = useToday();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  // The row created just now stays highlighted for a few seconds.
  const { flashKey, rowRef, flash } = useFlashRow<string>();
  // The drop-to-file flow in progress: how many documents were dropped and
  // how many are filed so far.
  const [reading, setReading] = useState<{
    total: number;
    done: number;
  } | null>(null);
  const [dropError, setDropError] = useState("");

  // Consume `?new=<id>` from the create redirect and drop the query param so
  // a reload doesn't re-highlight (replace keeps it out of history).
  useEffect(() => {
    const newId = searchParams.get("new");
    if (!newId) return;
    flash(newId);
    const next = new URLSearchParams(searchParams);
    next.delete("new");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, flash]);

  /** File one warranty per dropped document, in order. The reading happens
   * server-side (one request per document: store the file, read the fields,
   * create the record), so the page only reports progress and then reloads
   * the list. */
  async function fileDocuments(files: File[]) {
    setDropError("");
    setReading({ total: files.length, done: 0 });
    const created: string[] = [];
    for (const file of files) {
      const form = new FormData();
      form.set("intent", "create");
      form.set("file", file);
      try {
        const res = await fetch("/api/warranty", {
          method: "POST",
          body: form,
        });
        const body = (await res.json().catch(() => null)) as {
          id?: string;
          error?: string;
        } | null;
        if (!res.ok || !body?.id) {
          setDropError(body?.error ?? "Couldn't file that document.");
          break;
        }
        created.push(body.id);
      } catch {
        setDropError("Couldn't file that document.");
        break;
      }
      setReading({ total: files.length, done: created.length });
    }
    setReading(null);
    // Reload the list (and flash the first new row) through the same `?new=`
    // path the create editor uses.
    if (created.length > 0) {
      void navigate(`/warranties?new=${created[0]}`, { replace: true });
    }
  }

  const drop = useDropTarget({
    // One read at a time: a second drop while the first is being filed would
    // report progress for both at once.
    enabled: reading === null,
    accepts: isReceiptFile,
    onFiles: (files) => void fileDocuments(files),
    message: "Document detected — drop to file it as a warranty",
  });

  const buckets = useMemo(() => {
    const out: Record<WarrantyExpiryGroup, Warranty[]> = {
      expired: [],
      soon: [],
      later: [],
      none: [],
    };
    if (!today) return null;
    for (const w of warranties) {
      out[warrantyExpiryGroup(w.expiresAt, today)].push(w);
    }
    const byExpiry = (a: Warranty, b: Warranty) =>
      a.expiresAt.localeCompare(b.expiresAt);
    out.soon.sort(byExpiry);
    out.later.sort(byExpiry);
    // Most recently expired first: that is the one most likely still
    // actionable (a claim window, a repair claim).
    out.expired.sort((a, b) => b.expiresAt.localeCompare(a.expiresAt));
    return out;
  }, [warranties, today]);

  const row = (w: Warranty) => (
    <WarrantyRow
      key={w.id}
      warranty={w}
      today={today}
      flashed={w.id === flashKey}
      rowRef={rowRef}
    />
  );

  return (
    <PageShell
      icon={<ShieldCheck aria-hidden="true" className="h-5 w-5" />}
      title="Warranties"
      backLabel="Back to expenses"
      drop={drop}
      headerRight={
        <Button asChild size="sm">
          <Link to="/warranty/new">New warranty</Link>
        </Button>
      }
    >
      <LiveStatus>{drop.message}</LiveStatus>

      {reading ? (
        <div
          role="status"
          className="mb-4 flex items-center gap-2 rounded-xl border border-blue-100 bg-blue-50/60 px-4 py-3 text-sm font-medium text-gray-700 dark:border-gray-700 dark:bg-blue-900/60 dark:text-gray-200"
        >
          <Loader2
            aria-hidden="true"
            className="h-4 w-4 shrink-0 animate-spin text-blue-600 dark:text-blue-400"
          />
          {reading.total > 1
            ? `Reading document ${Math.min(reading.done + 1, reading.total)} of ${reading.total}…`
            : "Reading the document…"}
        </div>
      ) : null}
      {dropError ? <Alert className="mb-4">{dropError}</Alert> : null}

      {warranties.length === 0 ? (
        <EmptyState>
          <p>
            Drop a receipt, a warranty card, or a terms PDF anywhere on this
            page and it becomes a warranty: merchant, product, value, dates, and
            terms are read from the document.
          </p>
          <Button asChild className="mt-4">
            <Link to="/warranty/new">New warranty</Link>
          </Button>
        </EmptyState>
      ) : (
        <>
          <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
            Drop a receipt, a warranty card, or a terms PDF here to file it as a
            warranty.
          </p>
          {buckets === null ? (
            <ul className="flex flex-col gap-2">{warranties.map(row)}</ul>
          ) : (
            GROUPS.map((group) =>
              buckets[group.key].length === 0 ? null : (
                <Section key={group.key} title={group.title}>
                  <ul className="flex flex-col gap-2">
                    {buckets[group.key].map(row)}
                  </ul>
                </Section>
              ),
            )
          )}
        </>
      )}
    </PageShell>
  );
}

function WarrantyRow({
  warranty,
  today,
  flashed,
  rowRef,
}: {
  warranty: Warranty;
  today: string | null;
  flashed: boolean;
  rowRef: React.RefObject<HTMLLIElement | null>;
}) {
  const badge = warrantyExpiryBadge(warranty.expiresAt, today);
  return (
    <li ref={flashed ? rowRef : undefined}>
      <Card
        className={`overflow-hidden transition-colors ${
          flashed
            ? "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40"
            : ""
        }`}
      >
        <Link
          to={`/warranty/${warranty.id}`}
          className="flex items-center gap-3 p-3 transition-colors hover:bg-black/5 dark:hover:bg-white/5"
          aria-label={`${warranty.product}, ${warranty.merchant}, ${formatAmount(warranty.value)}, ${badge.label}`}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-semibold">
                {warranty.product || "No product"}
              </span>
              <span className="shrink-0 font-semibold tabular-nums">
                {formatAmount(warranty.value)}
              </span>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-gray-500 dark:text-gray-400">
              <span className="truncate">
                {warranty.merchant || "No merchant"}
              </span>
              {warranty.purchasedAt ? (
                <span>{formatDate(warranty.purchasedAt, { long: true })}</span>
              ) : null}
              <Badge tone={badge.tone}>{badge.label}</Badge>
              <span>{documentCountLabel(warranty.documents.length)}</span>
            </div>
          </div>
        </Link>
      </Card>
    </li>
  );
}
