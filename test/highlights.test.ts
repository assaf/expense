import { describe, expect, it } from "vitest";
import {
  availableHighlights,
  pickHighlight,
  type HighlightData,
} from "~/components/FeatureHighlight";

const EMPTY: HighlightData = {
  inboundAddress: "",
  mcpUrl: "",
  inviteCode: "",
  mileageRate: "",
};

const FULL: HighlightData = {
  inboundAddress: "receipts@example.com",
  mcpUrl: "https://expense.example.com/mcp",
  inviteCode: "ABCD-EFGH",
  mileageRate: "0.70",
};

describe("feature highlights", () => {
  it("always offers the always-on highlights", () => {
    expect(availableHighlights(EMPTY).sort()).toEqual([
      "capture",
      "categories",
      "mileage-location",
      "reconcile",
      "reports",
    ]);
  });

  it("offers the email highlight only when an inbound address is configured", () => {
    expect(availableHighlights(FULL)).toContain("email");
    expect(availableHighlights(EMPTY)).not.toContain("email");
  });

  it("offers the MCP highlight only when the endpoint is known", () => {
    expect(availableHighlights(FULL)).toContain("mcp");
    expect(availableHighlights(EMPTY)).not.toContain("mcp");
  });

  it("offers the IRS rate highlight only when a rate is published", () => {
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
});
