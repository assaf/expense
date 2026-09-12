import { MAX_TRIP_STOPS, recomputeMileage } from "~/lib/maps.server";
import { requireUser } from "~/lib/auth.server";
import { badRequest } from "~/lib/validation";
import { MAX_ADDRESS_LENGTH, parseLocations } from "~/lib/types";
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
    return badRequest("Invalid JSON");
  }
  // The body is untrusted, and every stop without coordinates becomes an
  // outbound geocode: bound the count, and refuse an address the app would
  // only truncate (the geocoder would route a prefix).
  const locations = parseLocations(body.locations);
  if (locations.length > MAX_TRIP_STOPS) {
    return badRequest(`A trip can have at most ${MAX_TRIP_STOPS} stops.`);
  }
  if (locations.some((stop) => stop.address.length > MAX_ADDRESS_LENGTH)) {
    return badRequest(
      "A stop address is too long — keep it under 300 characters.",
    );
  }
  const rate = typeof body.rate === "string" ? body.rate : "";
  // Only an explicit false makes it a one-way trip; anything else keeps the
  // closed loop every stored trip assumed.
  const roundTrip = body.roundTrip !== false;
  const result = await recomputeMileage(locations, rate, { roundTrip });
  return Response.json(result);
}
