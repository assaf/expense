import { useFetcher } from "react-router";
import { SenderRow } from "~/components/settings/receipts-by-email";
import { Badge } from "~/components/ui/Badge";
import { Card } from "~/components/ui/Card";
import { FieldLabel } from "~/components/ui/FieldLabel";
import { RemoveButton } from "~/components/ui/RemoveButton";
import { StatusNote } from "~/components/ui/StatusNote";
import type { AcceptedSenderRow, InboundSenderRecord } from "~/lib/types";

/** One list row's shell: the same surface SenderRow uses. */
const ROW_CLASS =
  "flex flex-col gap-1 rounded-lg bg-gray-50 px-3 py-1.5 dark:bg-gray-900";

/** One rule pattern the account accepts: the pattern, what taught it, and
 * the trash button that stops it filing mail. One fetcher per row, so the
 * submit state stays on the row it belongs to. */
function AcceptedRow({
  sender,
  badge,
  tone,
}: {
  sender: string;
  badge: string;
  tone: "blue" | "gray";
}) {
  const removeFetcher = useFetcher();
  return (
    <li className={ROW_CLASS}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-sm">{sender}</span>
          <Badge tone={tone} className="shrink-0">
            {badge}
          </Badge>
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <RemoveButton
            fetcher={removeFetcher}
            intent="removeAcceptedSender"
            fields={{ sender }}
            label={`Remove ${sender}`}
            confirm={`Stop filing receipts from ${sender} automatically? New ones will wait on the review list.`}
          />
        </div>
      </div>
    </li>
  );
}

/** One turned-off pre-selected sender, with the control that puts it back. */
function TurnedOffRow({ sender }: { sender: string }) {
  const restoreFetcher = useFetcher();
  return (
    <li className={ROW_CLASS}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-sm">{sender}</span>
          <Badge tone="amber" className="shrink-0">
            Turned off
          </Badge>
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <restoreFetcher.Form method="post" className="contents">
            <input type="hidden" name="intent" value="restoreAcceptedSender" />
            <input type="hidden" name="sender" value={sender} />
            <button
              type="submit"
              className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
              aria-label={`Restore ${sender}`}
            >
              Restore
            </button>
          </restoreFetcher.Form>
        </div>
      </div>
    </li>
  );
}

/**
 * The accepted senders on the Email page: the forwarding addresses this
 * account verified, the senders it taught the app by forwarding or by
 * accepting one in review, and the pre-selected senders that apply to every
 * workspace. Turning one off stops it filing automatically and puts its mail
 * back on the review list; restoring a pre-selected one is what undo means
 * here, since a rule the account learned itself is gone once removed.
 */
export function AcceptedSenders({
  rows,
  inboundSenders,
  userEmail,
}: {
  rows: AcceptedSenderRow[];
  inboundSenders: InboundSenderRecord[];
  userEmail: string;
}) {
  const learned = rows.filter((r) => !r.turnedOff && r.origin === "learned");
  const presets = rows.filter((r) => !r.turnedOff && r.origin === "preset");
  const turnedOff = rows.filter((r) => r.turnedOff);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <FieldLabel as="div" className="mb-1">
          Senders you approved
        </FieldLabel>
        <Card className="p-4">
          <ul className="flex flex-col gap-1">
            {inboundSenders.length === 0 ? (
              <StatusNote as="li">None yet.</StatusNote>
            ) : (
              inboundSenders.map((sender) => (
                <SenderRow
                  key={sender.address}
                  sender={sender}
                  isDefault={sender.address === userEmail}
                />
              ))
            )}
          </ul>
        </Card>
      </div>
      <div>
        <FieldLabel as="div" className="mb-1">
          Learned from your receipts
        </FieldLabel>
        <Card className="p-4">
          <ul className="flex flex-col gap-1">
            {learned.length === 0 ? (
              <StatusNote as="li">None yet.</StatusNote>
            ) : (
              learned.map((row) => (
                <AcceptedRow
                  key={row.sender}
                  sender={row.sender}
                  badge="Learned"
                  tone="blue"
                />
              ))
            )}
          </ul>
        </Card>
      </div>
      <div>
        <FieldLabel as="div" className="mb-1">
          Pre-selected by Expense
        </FieldLabel>
        <Card className="p-4">
          <ul className="flex flex-col gap-1">
            {presets.length === 0 ? (
              <StatusNote as="li">None yet.</StatusNote>
            ) : (
              presets.map((row) => (
                <AcceptedRow
                  key={row.sender}
                  sender={row.sender}
                  badge="Pre-selected"
                  tone="gray"
                />
              ))
            )}
          </ul>
        </Card>
      </div>
      {turnedOff.length === 0 ? null : (
        <div>
          <FieldLabel as="div" className="mb-1">
            Turned off
          </FieldLabel>
          <Card className="p-4">
            <ul className="flex flex-col gap-1">
              {turnedOff.map((row) => (
                <TurnedOffRow key={row.sender} sender={row.sender} />
              ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}
