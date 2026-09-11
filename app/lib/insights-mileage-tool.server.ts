import { z } from "zod";
import { MAX_TOOL_ARGUMENTS } from "~/lib/insights-tools.server";
import { MAX_TRIP_STOPS } from "~/lib/maps.server";
import { resolveMileage } from "~/lib/mcp-write.server";
import type { ToolSpec } from "~/lib/receipt-ai.server";
import { parseLocations, type Location, type MileageType } from "~/lib/types";

/**
 * The insights chat's one write-shaped tool: the model resolves "the drive
 * from the office back home on Tuesday" into a real, priced trip, and the
 * app shows the user a card to confirm. Nothing is written here.
 *
 * This module is deliberately not part of insights-tools.server.ts, whose
 * contract is "read-only and in-memory: no DB round trip, no writes": this
 * tool geocodes and routes over the network, and hands the route a
 * proposal. The model reaches `resolveMileage` (validate + geocode + route
 * + price) and never a write; confirming is the user's click, not a model
 * decision. A separate module also keeps the mileage module graph (its
 * heavy leaves are all dynamic imports) off the read-tool contract.
 */

export const PLAN_MILEAGE = "plan_mileage";

/** What the chat resolved a trip into: everything the confirm card shows,
 * and the only thing the confirm action accepts back. */
export interface PendingTrip {
  stops: Location[];
  date: string;
  type: MileageType;
  report: string;
  description: string;
  distanceMiles: string;
  amount: string;
  rate: string;
  approximate: boolean;
}

/** What the plan tool needs from the request: the account to resolve
 * against, the plain report names it may file into, and the user's local
 * date (the default trip date, since the server runs UTC: its own "today"
 * is already tomorrow for a west-coast evening). */
export interface PlanMileageContext {
  accountId: string;
  reportNames: string[];
  today?: string;
}

const planMileageInput = z.object({
  stops: z
    .array(z.string().max(300))
    .min(2)
    .max(MAX_TRIP_STOPS)
    .describe(
      "The trip's stops in order, as addresses (2 or more). The first is the start.",
    ),
  date: z.string().optional().describe("Trip date YYYY-MM-DD; omit for today."),
  type: z
    .enum(["business", "charity", "medical", "moving"])
    .optional()
    .describe("IRS trip type; business unless the user says otherwise."),
  report: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Report name to file the trip in; omit unless the user names one.",
    ),
  description: z
    .string()
    .max(300)
    .optional()
    .describe("Short note for the trip's description field."),
});

export function planMileageTool(): ToolSpec {
  return {
    type: "function",
    function: {
      name: PLAN_MILEAGE,
      description:
        "Work out a drive the user asked to log: geocode the stops, route the trip, and price it at the IRS mileage rate. Returns the trip for the user to confirm — it files nothing. Call it at most once per question.",
      parameters: z.toJSONSchema(planMileageInput),
    },
  };
}

/** The trip inputs the confirm card posts back: the proposal's own inputs
 * and nothing computed. The distance and the amount stay the server's —
 * confirming re-resolves the trip — so no payload can file a number the app
 * did not compute. */
export interface TripConfirmation {
  stops: Location[];
  date: string;
  type: MileageType;
  report: string;
  description: string;
}

const confirmationSchema = z.object({
  stops: z
    .array(
      z.object({
        address: z.string().max(300),
        lat: z.number().finite().min(-90).max(90).nullable(),
        lng: z.number().finite().min(-180).max(180).nullable(),
      }),
    )
    .min(2)
    .max(MAX_TRIP_STOPS),
  date: z.string().max(20),
  type: z.enum(["business", "charity", "medical", "moving"]),
  report: z.string().max(200),
  description: z.string().max(300),
});

/** Parse the confirm card's payload (its JSON, in one form field). Returns
 * null when it is missing or malformed: the card is the only producer, so
 * anything else is a stale tab or an edited request. */
export function parseTripConfirmation(raw: string): TripConfirmation | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = confirmationSchema.safeParse(value);
  if (!parsed.success) return null;
  const stops = parseLocations(parsed.data.stops).filter(
    (l) => l.address.trim() !== "",
  );
  if (stops.length < 2) return null;
  return { ...parsed.data, stops };
}

/**
 * Resolve one plan_mileage call. `resolve` is injectable (the house
 * pattern) so tests exercise the tool without the map services.
 *
 * The result is what the model reads; `pending` is the proposal the route
 * returns to the browser. Every rejection carries `{ error }` and no
 * pending: a wrong trip is worse than no trip.
 */
export async function runPlanMileage(
  writes: PlanMileageContext,
  call: { function: { arguments: string } },
  resolve: typeof resolveMileage = resolveMileage,
): Promise<{ result: string; pending?: PendingTrip }> {
  // Same bound the read tool applies: the provider is untrusted, and this
  // argument string is parsed on the request path.
  if (call.function.arguments.length > MAX_TOOL_ARGUMENTS) {
    return { result: JSON.stringify({ error: "arguments were too long" }) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(call.function.arguments || "{}");
  } catch {
    return {
      result: JSON.stringify({ error: "arguments were not valid JSON" }),
    };
  }
  const parsed = planMileageInput.safeParse(raw);
  if (!parsed.success) {
    return {
      result: JSON.stringify({
        error: "invalid trip",
        issues: parsed.error.issues.map((i) => i.message).slice(0, 5),
      }),
    };
  }
  const args = parsed.data;
  const report = args.report?.trim() ?? "";
  // The profile lists the account's reports, so the valid names are
  // already in the model's context; this only rejects a name the model
  // invented (or one that does not exist).
  if (report && !writes.reportNames.includes(report)) {
    return {
      result: JSON.stringify({ error: `No report named "${report}".` }),
    };
  }

  const resolved = await resolve(writes.accountId, {
    locations: args.stops,
    date: args.date || writes.today || undefined,
    type: args.type,
    report: report || undefined,
  });
  if (!resolved.ok) {
    return { result: JSON.stringify({ error: resolved.error }) };
  }
  const trip = resolved.trip;
  // An address the geocoder could not place: a straight-line trip from
  // somewhere the user did not say is worse than an error, so this asks
  // for a fuller address instead of proposing a made-up route. Real
  // coordinates with `approximate: true` are fine: the routing service is
  // degraded there, not the address.
  const unlocated = trip.locations.find(
    (l) => l.lat === null || l.lng === null,
  );
  if (unlocated) {
    return {
      result: JSON.stringify({
        error: `Couldn't locate "${unlocated.address}". Ask for a fuller address.`,
      }),
    };
  }

  return {
    result: JSON.stringify({
      ok: true,
      date: trip.date,
      type: trip.type,
      report: trip.report,
      stops: trip.locations.map((l) => ({
        address: l.address,
        lat: l.lat,
        lng: l.lng,
      })),
      distanceMiles: trip.distanceMiles,
      amount: trip.amount,
      rate: trip.rate || null,
      approximate: trip.approximate,
    }),
    pending: {
      stops: trip.locations,
      date: trip.date,
      type: trip.type,
      report: trip.report,
      description: args.description?.trim() ?? "",
      distanceMiles: trip.distanceMiles,
      amount: trip.amount,
      rate: trip.rate,
      approximate: trip.approximate,
    },
  };
}
