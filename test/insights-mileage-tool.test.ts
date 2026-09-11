import { describe, expect, it, vi } from "vitest";
import { MAX_TOOL_ARGUMENTS } from "~/lib/insights-tools.server";
import { MAX_TRIP_STOPS } from "~/lib/maps.server";
import type { ResolvedTrip, resolveMileage } from "~/lib/mcp-write.server";
import {
  parseTripConfirmation,
  runPlanMileage,
} from "~/lib/insights-mileage-tool.server";

/**
 * The plan tool is the insights chat's only path toward a write: it
 * resolves a trip and hands the route a proposal, and must reject anything
 * it cannot resolve exactly. The map services are replaced by an injected
 * resolver here; the real geocode/route/price flow is covered by
 * test/maps-wire-shape.test.ts and the route's end-to-end test.
 */

const OFFICE = {
  address: "1 Office Way, Testing, CA",
  lat: 34.02,
  lng: -118.28,
};
const HOME = { address: "2 Home St, Testing, CA", lat: 34.05, lng: -118.24 };

function trip(overrides: Partial<ResolvedTrip> = {}): ResolvedTrip {
  return {
    date: "2026-07-14",
    report: "",
    type: "business",
    locations: [OFFICE, HOME],
    distanceMiles: "12.34",
    amount: "9.38",
    rate: "0.76",
    approximate: false,
    coords: [
      [34.02, -118.28],
      [34.05, -118.24],
    ],
    returnCoords: [
      [34.05, -118.24],
      [34.02, -118.28],
    ],
    ...overrides,
  };
}

/** The request context the route supplies (the user's local date, since
 * the server runs UTC). */
const writes = {
  accountId: "acct_1",
  reportNames: ["Q3"],
  today: "2026-07-15",
};

function call(args: unknown): { function: { arguments: string } } {
  return { function: { arguments: JSON.stringify(args) } };
}

function resolvesTo(resolved: ResolvedTrip) {
  return vi.fn<typeof resolveMileage>(async () => ({
    ok: true as const,
    trip: resolved,
  }));
}

function failsWith(error: string) {
  return vi.fn<typeof resolveMileage>(async () => ({
    ok: false as const,
    error,
  }));
}

describe("runPlanMileage", () => {
  it("proposes the resolved trip and reports it to the model", async () => {
    const resolver = resolvesTo(trip());
    const out = await runPlanMileage(
      writes,
      call({
        stops: ["1 Office Way", "2 Home St"],
        description: "Client visit",
      }),
      resolver,
    );

    // The card's data: the resolved stops and the app's own figures.
    expect(out.pending).toEqual({
      stops: [OFFICE, HOME],
      date: "2026-07-14",
      type: "business",
      report: "",
      description: "Client visit",
      distanceMiles: "12.34",
      amount: "9.38",
      rate: "0.76",
      approximate: false,
    });
    // The model reads the same trip, structured.
    expect(JSON.parse(out.result)).toEqual({
      ok: true,
      date: "2026-07-14",
      type: "business",
      report: "",
      stops: [
        { address: OFFICE.address, lat: OFFICE.lat, lng: OFFICE.lng },
        { address: HOME.address, lat: HOME.lat, lng: HOME.lng },
      ],
      distanceMiles: "12.34",
      amount: "9.38",
      rate: "0.76",
      approximate: false,
    });
    expect(resolver.mock.calls[0]![0]).toBe("acct_1");
    expect(resolver.mock.calls[0]![1]).toEqual({
      locations: ["1 Office Way", "2 Home St"],
      date: "2026-07-15",
      type: undefined,
      report: undefined,
    });
  });

  it("lets an explicit date win over the user's today", async () => {
    const resolver = resolvesTo(trip({ date: "2026-07-14" }));
    await runPlanMileage(
      writes,
      call({ stops: ["a", "b"], date: "2026-07-14", type: "charity" }),
      resolver,
    );
    expect(resolver.mock.calls[0]![1]).toMatchObject({
      date: "2026-07-14",
      type: "charity",
    });
  });

  it("reports no rate as null rather than zero", async () => {
    const resolver = resolvesTo(trip({ rate: "", amount: "" }));
    const out = await runPlanMileage(
      writes,
      call({ stops: ["a", "b"] }),
      resolver,
    );
    expect(JSON.parse(out.result)).toMatchObject({ rate: null, amount: "" });
    expect(out.pending?.rate).toBe("");
  });

  it("proposes an approximate trip whose addresses did resolve", async () => {
    const resolver = resolvesTo(trip({ approximate: true }));
    const out = await runPlanMileage(
      writes,
      call({ stops: ["a", "b"] }),
      resolver,
    );
    expect(out.pending?.approximate).toBe(true);
    expect(JSON.parse(out.result)).toMatchObject({
      approximate: true,
      distanceMiles: "12.34",
    });
  });

  it("rejects a report the account doesn't have", async () => {
    const resolver = resolvesTo(trip());
    const out = await runPlanMileage(
      writes,
      call({ stops: ["a", "b"], report: "Q4" }),
      resolver,
    );
    expect(JSON.parse(out.result)).toEqual({ error: 'No report named "Q4".' });
    expect(out.pending).toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects more stops than a trip may have", async () => {
    const resolver = resolvesTo(trip());
    const stops = Array.from({ length: MAX_TRIP_STOPS + 1 }, () => "a stop");
    const out = await runPlanMileage(writes, call({ stops }), resolver);
    expect(JSON.parse(out.result).error).toBe("invalid trip");
    expect(out.pending).toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects malformed and over-long arguments without resolving", async () => {
    const resolver = resolvesTo(trip());
    const malformed = await runPlanMileage(
      writes,
      { function: { arguments: "not json" } },
      resolver,
    );
    expect(JSON.parse(malformed.result)).toEqual({
      error: "arguments were not valid JSON",
    });
    const tooLong = await runPlanMileage(
      writes,
      { function: { arguments: " ".repeat(MAX_TOOL_ARGUMENTS + 1) } },
      resolver,
    );
    expect(JSON.parse(tooLong.result)).toEqual({
      error: "arguments were too long",
    });
    expect(malformed.pending).toBeUndefined();
    expect(tooLong.pending).toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });

  it("surfaces the resolver's validation error", async () => {
    const out = await runPlanMileage(
      writes,
      call({ stops: ["a", "b"], date: "not-a-date" }),
      failsWith("Use a valid calendar date."),
    );
    expect(JSON.parse(out.result)).toEqual({
      error: "Use a valid calendar date.",
    });
    expect(out.pending).toBeUndefined();
  });

  it("refuses to propose a trip with an address that did not resolve", async () => {
    const out = await runPlanMileage(
      writes,
      call({ stops: ["nowhere", "2 Home St"] }),
      resolvesTo(
        trip({
          locations: [{ address: "nowhere", lat: null, lng: null }, HOME],
        }),
      ),
    );
    expect(JSON.parse(out.result)).toEqual({
      error: 'Couldn\'t locate "nowhere". Ask for a fuller address.',
    });
    expect(out.pending).toBeUndefined();
  });
});

describe("parseTripConfirmation", () => {
  it("normalizes the card's payload into typed stops", () => {
    const raw = JSON.stringify({
      stops: [OFFICE, HOME],
      date: "2026-07-14",
      type: "business",
      report: "Q3",
      description: "Client visit",
    });
    expect(parseTripConfirmation(raw)).toEqual({
      stops: [OFFICE, HOME],
      date: "2026-07-14",
      type: "business",
      report: "Q3",
      description: "Client visit",
    });
  });

  it("rejects anything that is not a two-stop trip", () => {
    const payload = (stops: unknown, extra: object = {}) =>
      JSON.stringify({
        stops,
        date: "",
        type: "business",
        report: "",
        description: "",
        ...extra,
      });
    expect(parseTripConfirmation("")).toBeNull();
    expect(parseTripConfirmation("not json")).toBeNull();
    // A single stop, a blank address, and a missing field are all stale or
    // hand-edited payloads.
    expect(parseTripConfirmation(payload([OFFICE]))).toBeNull();
    expect(
      parseTripConfirmation(payload([{ ...OFFICE, address: "" }, HOME])),
    ).toBeNull();
    expect(
      parseTripConfirmation(JSON.stringify({ stops: [OFFICE, HOME] })),
    ).toBeNull();
    // Coordinates must be real ones when present.
    expect(
      parseTripConfirmation(payload([{ ...OFFICE, lat: 999 }, HOME])),
    ).toBeNull();
    // An unknown trip type never reaches the rate lookup.
    expect(
      parseTripConfirmation(payload([OFFICE, HOME], { type: "teleport" })),
    ).toBeNull();
  });
});
