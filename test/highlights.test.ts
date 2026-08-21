import { describe, expect, it } from "vitest";
import {
  availableHighlights,
  pickHighlight,
  type HighlightData,
  type HighlightId,
} from "~/components/FeatureHighlight";

const EMPTY: HighlightData = {
  inboundAddress: "",
  mcpUrl: "",
  inviteCode: "",
  mileageRate: "",
  hasRates: false,
  hasEmailConnection: false,
};

const FULL: HighlightData = {
  inboundAddress: "receipts@example.com",
  mcpUrl: "https://expense.example.com/mcp",
  inviteCode: "ABCD-EFGH",
  mileageRate: "0.70",
  hasRates: true,
  hasEmailConnection: true,
};

describe("feature highlights", () => {
  it("always offers the always-on highlights", () => {
    expect(availableHighlights(EMPTY).sort()).toEqual([
      "capture",
      "categories",
      "connect-email",
      "mileage-location",
      "reconcile",
      "reports",
    ]);
  });

  it("offers the connect-email highlight only when no mailbox is connected", () => {
    expect(availableHighlights(EMPTY)).toContain("connect-email");
    expect(availableHighlights(FULL)).not.toContain("connect-email");
  });

  it("offers the email highlight only when an inbound address is configured", () => {
    expect(availableHighlights(FULL)).toContain("email");
    expect(availableHighlights(EMPTY)).not.toContain("email");
  });

  it("offers the MCP highlight only when the endpoint is known", () => {
    expect(availableHighlights(FULL)).toContain("mcp");
    expect(availableHighlights(EMPTY)).not.toContain("mcp");
  });

  it("offers the IRS rate highlight only when rates exist", () => {
    expect(availableHighlights(FULL)).toContain("mileage-rate");
    expect(availableHighlights(EMPTY)).not.toContain("mileage-rate");
  });

  it("offers the invite highlight only when an invite code exists", () => {
    expect(availableHighlights(FULL)).toContain("invite");
    expect(availableHighlights(EMPTY)).not.toContain("invite");
  });

  it("picks only from the available pool", () => {
    for (let i = 0; i < 50; i++) {
      expect(availableHighlights(EMPTY)).toContain(pickHighlight(EMPTY));
      expect(availableHighlights(FULL)).toContain(pickHighlight(FULL));
    }
  });

  it("boost triples the odds for a pool member and is ignored otherwise", () => {
    const unconnectedPool = availableHighlights(EMPTY); // includes connect-email
    const connectedPool = availableHighlights(FULL); // does not
    const seen: HighlightId[] = [];
    for (let i = 0; i < 200; i++) {
      const boosted = pickHighlight(EMPTY, "connect-email");
      seen.push(boosted);
      expect(unconnectedPool).toContain(boosted);
      // Boosting an id outside the pool is a no-op.
      expect(connectedPool).toContain(pickHighlight(FULL, "connect-email"));
    }
    const connectShare =
      seen.filter((h) => h === "connect-email").length / seen.length;
    // 3 copies out of (pool size + 2) — roughly 3x the base share. A wide
    // window keeps the assertion robust against random noise.
    const baseShare = 1 / unconnectedPool.length;
    expect(connectShare).toBeGreaterThan(baseShare * 2);
  });
});
