import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import { Form, useNavigation } from "react-router";
import { Badge } from "~/components/ui/Badge";
import { Card } from "~/components/ui/Card";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { FieldLabel } from "~/components/ui/FieldLabel";
import { StatusNote } from "~/components/ui/StatusNote";
import type { AcceptedSenderRow } from "~/lib/types";

/** One list row's shell: the same surface the Email page's other rows use. */
const ROW_CLASS =
  "flex flex-col gap-1 rounded-lg bg-gray-50 px-3 py-1.5 dark:bg-gray-900";

/**
 * A rule row's view-transition name. A custom ident may not contain a dot or
 * "@", and two rows must never end up with the same name or the browser
 * skips both silently, so every non-alphanumeric is hex-escaped instead of
 * stripped: one name per pattern, still readable by eye.
 */
function ruleTransitionName(sender: string): string {
  return `rule-${sender.replace(/[^a-z0-9]/g, (c) => `-${c.charCodeAt(0).toString(16)}`)}`;
}

/**
 * The trash control for a rule row. Unlike the app's shared RemoveButton,
 * this submits a real navigation: react-router only starts a view
 * transition for navigations (a fetcher submission drops the option), and
 * that transition is what moves the row to its new group. The confirm gate
 * sits in front of the same submit either way.
 *
 * `preventScrollReset` is what keeps the page where it was; `replace` is not
 * needed, because the action redirects back to /emails and the router
 * already replaces a redirect whose target is the current location (the
 * test's history check holds that up).
 *
 * The dialog is portaled to the body because the row carries a
 * view-transition-name, and that is a stacking context: a dialog rendered
 * inside the row paints under the rows that follow it, which then swallow
 * the click (the trap is scroll-dependent, so it fails only sometimes).
 */
function RemoveRuleButton({ sender }: { sender: string }) {
  const [asking, setAsking] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  // The first submit asks; the confirmed one is let through.
  const confirmed = useRef(false);
  const navigation = useNavigation();
  return (
    <>
      <Form
        ref={formRef}
        method="post"
        preventScrollReset
        viewTransition
        className="contents"
        onSubmit={(e) => {
          if (confirmed.current) return;
          e.preventDefault();
          setAsking(true);
        }}
      >
        <input type="hidden" name="intent" value="removeAcceptedSender" />
        <input type="hidden" name="sender" value={sender} />
        <button
          type="submit"
          disabled={navigation.state !== "idle"}
          className="text-gray-500 hover:text-red-600 disabled:opacity-50 dark:text-gray-400 dark:text-red-400"
          aria-label={`Remove ${sender}`}
        >
          <Trash2 aria-hidden="true" className="h-4 w-4" />
        </button>
      </Form>
      {asking
        ? createPortal(
            <ConfirmDialog
              message={`Stop filing receipts from ${sender} automatically? New ones will wait on the review list.`}
              onConfirm={() => {
                confirmed.current = true;
                setAsking(false);
                formRef.current?.requestSubmit();
              }}
              onCancel={() => {
                confirmed.current = false;
                setAsking(false);
              }}
              deleting={navigation.state !== "idle"}
            />,
            document.body,
          )
        : null}
    </>
  );
}

/** One sender the app imports from: the pattern, what taught it, and the
 * trash button that stops it filing mail. */
function RuleRow({
  sender,
  badge,
  tone,
}: {
  sender: string;
  badge: string;
  tone: "blue" | "gray";
}) {
  return (
    <li
      className={ROW_CLASS}
      style={{ viewTransitionName: ruleTransitionName(sender) }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-sm">{sender}</span>
          <Badge tone={tone} className="shrink-0">
            {badge}
          </Badge>
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <RemoveRuleButton sender={sender} />
        </div>
      </div>
    </li>
  );
}

/** One turned-off pre-selected sender, with the control that puts it back. */
function TurnedOffRow({ sender }: { sender: string }) {
  return (
    <li
      className={ROW_CLASS}
      style={{ viewTransitionName: ruleTransitionName(sender) }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-sm">{sender}</span>
          <Badge tone="amber" className="shrink-0">
            Turned off
          </Badge>
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <Form
            method="post"
            preventScrollReset
            viewTransition
            className="contents"
          >
            <input type="hidden" name="intent" value="restoreAcceptedSender" />
            <input type="hidden" name="sender" value={sender} />
            <button
              type="submit"
              className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
              aria-label={`Restore ${sender}`}
            >
              Restore
            </button>
          </Form>
        </div>
      </div>
    </li>
  );
}

/**
 * The senders the app imports from automatically: the ones this workspace
 * taught it (a forwarded receipt, or accepting one in review) and the
 * pre-selected ones that apply to every workspace. Turning one off stops it
 * filing automatically and puts its mail back on the review list; restoring
 * a pre-selected one is what undo means here, since a rule the workspace
 * learned itself is gone once removed.
 */
export function AutoImportedSenders({ rows }: { rows: AcceptedSenderRow[] }) {
  const learned = rows.filter((r) => !r.turnedOff && r.origin === "learned");
  const presets = rows.filter((r) => !r.turnedOff && r.origin === "preset");
  const turnedOff = rows.filter((r) => r.turnedOff);
  return (
    <div className="flex flex-col gap-4">
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
                <RuleRow
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
                <RuleRow
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
