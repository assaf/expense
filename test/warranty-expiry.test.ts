import { describe, expect, it } from "vite-plus/test";
import {
  warrantyExpiryBadge,
  warrantyExpiryGroup,
  warrantyExpiryLabel,
} from "~/lib/warranty-expiry";

/** The pinned suite date, so the boundaries below are fixed. */
const TODAY = "2026-07-15";

describe("warranty expiry grouping", () => {
  it("groups by how close the expiry is", () => {
    expect(warrantyExpiryGroup("", TODAY)).toBe("none");
    expect(warrantyExpiryGroup("2026-07-14", TODAY)).toBe("expired");
    expect(warrantyExpiryGroup(TODAY, TODAY)).toBe("soon");
    expect(warrantyExpiryGroup("2026-10-13", TODAY)).toBe("soon"); // +90
    expect(warrantyExpiryGroup("2026-10-14", TODAY)).toBe("later"); // +91
  });

  it("counts across month and year boundaries", () => {
    expect(warrantyExpiryGroup("2027-01-13", "2026-10-15")).toBe("soon");
    expect(warrantyExpiryGroup("2026-02-28", "2026-03-01")).toBe("expired");
  });

  it("treats an unparseable date as no expiry", () => {
    expect(warrantyExpiryGroup("not-a-date", TODAY)).toBe("none");
  });
});

describe("warranty expiry labels", () => {
  it("names the day count, the date, or no expiry", () => {
    expect(warrantyExpiryLabel("", TODAY)).toBe("No expiry");
    expect(warrantyExpiryLabel("2026-07-03", TODAY)).toBe(
      "Expired 12 days ago",
    );
    expect(warrantyExpiryLabel("2026-07-14", TODAY)).toBe("Expired 1 day ago");
    expect(warrantyExpiryLabel(TODAY, TODAY)).toBe("Expires today");
    expect(warrantyExpiryLabel("2026-07-16", TODAY)).toBe("Expires tomorrow");
    expect(warrantyExpiryLabel("2026-08-29", TODAY)).toBe("Expires in 45 days");
    expect(warrantyExpiryLabel("2027-03-14", TODAY)).toBe("Expires 2027-03-14");
  });

  it("names the date instead of judging it before mount", () => {
    expect(warrantyExpiryBadge("2027-03-14", null)).toEqual({
      tone: "gray",
      label: "Expires 2027-03-14",
    });
    expect(warrantyExpiryBadge("2026-07-03", TODAY).tone).toBe("red");
    expect(warrantyExpiryBadge(TODAY, TODAY).tone).toBe("amber");
    expect(warrantyExpiryBadge("2027-03-14", TODAY).tone).toBe("blue");
    expect(warrantyExpiryBadge("", TODAY).tone).toBe("gray");
  });
});
