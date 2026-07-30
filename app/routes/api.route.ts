import { recomputeMileage } from "~/lib/maps.server";
import type { Location } from "~/lib/types";
import type { Route } from "./+types/api.route";

interface RouteRequestBody {
  locations?: Location[];
  rate?: string;
}

export async function action({ request }: Route.ActionArgs) {
  let body: RouteRequestBody;
  try {
    body = (await request.json()) as RouteRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const locations = Array.isArray(body.locations) ? body.locations : [];
  const rate = typeof body.rate === "string" ? body.rate : "";
  const result = await recomputeMileage(locations, rate);
  return Response.json(result);
}
