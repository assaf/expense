import { z } from "zod";
import {
  parseConfirmationPayload,
  parseToolArguments,
} from "~/lib/insights-tools.server";
import type { PlanContext } from "~/lib/insights-plan.server";
import { MAX_TRIP_STOPS } from "~/lib/maps.server";
import { resolveMileage } from "~/lib/mcp-write.server";
import type { ToolSpec } from "~/lib/receipt-ai.server";
import { parseLocations, type Location, type MileageType } from "~/lib/types";

/**
 * The insights chat's mileage plan tool: the model resolves "the drive
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
  kind: "mileage";
  stops: Location[];
  date: string;
  type: MileageType;
  report: string;
  description: string;
  distanceMiles: string;
  amount: string;
  rate: string;
  approximate: boolean;
  /** Whether the drive returns to the first stop. One way unless the user
   * asked to come back. */
  roundTrip: boolean;
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
  roundTrip: z
    .boolean()
    .optional()
    .describe(
      "True only when the drive returns to the first stop (there and back); one way by default.",
    ),
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
  roundTrip: boolean;
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
  // A payload without the field (a tab opened before one-way existed, or a
  // hand-edited request) is a one-way trip: the default, never a loop.
  roundTrip: z.boolean().optional(),
});

/** Parse the confirm card's payload (its JSON, in one form field). Returns
 * null when it is missing or malformed: the card is the only producer, so
 * anything else is a stale tab or an edited request. */
export function parseTripConfirmation(raw: string): TripConfirmation | null {
  const parsed = parseConfirmationPayload(confirmationSchema, raw);
  if (!parsed) return null;
  const stops = parseLocations(parsed.stops).filter(
    (l) => l.address.trim() !== "",
  );
  if (stops.length < 2) return null;
  return {
    ...parsed,
    stops,
    roundTrip: parsed.roundTrip ?? false,
  };
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
  writes: PlanContext,
  call: { function: { arguments: string } },
  resolve: typeof resolveMileage = resolveMileage,
): Promise<{ result: string; pending?: PendingTrip }> {
  const parsed = parseToolArguments(planMileageInput, call, "invalid trip");
  if (!parsed.ok) return { result: parsed.error };
  const args = parsed.data;
  const resolved = await resolve(writes.accountId, {
    locations: args.stops,
    date: args.date || writes.today || undefined,
    type: args.type,
    // The resolver owns the report rule (it must exist and be open); an
    // invented name comes back as its message.
    report: args.report?.trim() || undefined,
    // Explicit: one way unless the user said they came back.
    roundTrip: args.roundTrip ?? false,
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
      roundTrip: trip.roundTrip,
    }),
    pending: {
      kind: "mileage",
      stops: trip.locations,
      date: trip.date,
      type: trip.type,
      report: trip.report,
      description: args.description?.trim() ?? "",
      distanceMiles: trip.distanceMiles,
      amount: trip.amount,
      rate: trip.rate,
      approximate: trip.approximate,
      roundTrip: trip.roundTrip,
    },
  };
}
