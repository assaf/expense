import { MAX_TRIP_STOPS, recomputeMileage } from "~/lib/maps.server";
import { requireUser } from "~/lib/auth.server";
import { parseLocations } from "~/lib/types";
import type { Route } from "./+types/api.route";

interface RouteRequestBody {
  locations?: unknown;
  rate?: string;
  roundTrip?: unknown;
}

export async function action({ request }: Route.ActionArgs) {
  await requireUser(request);
  let body: RouteRequestBody;
  try {
    body = (await request.json()) as RouteRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  // The body is untrusted, and every stop without coordinates becomes an
  // outbound geocode: normalize each stop and bound the count.
  const locations = parseLocations(body.locations);
  if (locations.length > MAX_TRIP_STOPS) {
    return Response.json(
      { error: `A trip can have at most ${MAX_TRIP_STOPS} stops.` },
      { status: 400 },
    );
  }
  const rate = typeof body.rate === "string" ? body.rate : "";
  // Only an explicit false makes it a one-way trip; anything else keeps the
  // closed loop every stored trip assumed.
  const roundTrip = body.roundTrip !== false;
  const result = await recomputeMileage(locations, rate, { roundTrip });
  return Response.json(result);
}
