import {
  FeatureHighlight,
  HIGHLIGHT_IDS,
  type HighlightData,
} from "~/components/FeatureHighlight";
import { requireUser } from "~/lib/auth.server";
import type { Route } from "./+types/[_]highlights";

/** Sample data chosen to render every card: the mailbox is shown as
 * unconnected so the connect nudge renders, and rates/invite/inbound are
 * placeholders (never the account's real values). */
const SAMPLE_DATA: HighlightData = {
  inboundAddress: "receipts@labnotes.org",
  mcpUrl: "https://expense.labnotes.org/mcp",
  inviteCode: "ABCD-1234",
  mileageRate: "0.76",
  hasRates: true,
  hasEmailConnection: false,
};

export function meta(): Route.MetaDescriptors {
  return [
    { title: "Feature highlights preview — Expense" },
    { name: "robots", content: "noindex" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  return null;
}

export default function DevHighlightsPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-xl font-semibold text-ink">
        Feature highlights preview
      </h1>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Every highlight card with sample data, for review. The invite code and
        inbound address are placeholders, and the mailbox is shown as
        unconnected so the connect nudge renders.
      </p>
      <div>
        {HIGHLIGHT_IDS.map((id) => (
          <FeatureHighlight key={id} id={id} data={SAMPLE_DATA} />
        ))}
      </div>
    </div>
  );
}
