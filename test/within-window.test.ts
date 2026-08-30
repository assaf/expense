import { describe, expect, it } from "vitest";
import { VERIFICATION_RESEND_MS, withinWindow } from "~/lib/db/shared";
import { toIso } from "~/lib/db/wire";

/**
 * withinWindow is the single polarity point for eight cooldown/TTL checks
 * (account + sender verification resends, token expiry). The boundary
 * semantics matter: missing timestamps are false, junk timestamps are
 * false, the window edge is exclusive, and wire-format timestamps (space
 * separator) must parse as UTC, not local time.
 */

/** Wire-format text ("2026-07-15 12:00:03.602") for `ago` ms before now. */
function wireAgo(ago: number): string {
  return new Date(Date.now() - ago)
    .toISOString()
    .replace("T", " ")
    .slice(0, 23);
}

describe("withinWindow", () => {
  it("treats a missing timestamp as outside every window", () => {
    expect(withinWindow(null, VERIFICATION_RESEND_MS)).toBe(false);
    expect(withinWindow(undefined, VERIFICATION_RESEND_MS)).toBe(false);
    expect(withinWindow("", VERIFICATION_RESEND_MS)).toBe(false);
  });

  it("treats an unparseable timestamp as outside the window", () => {
    expect(withinWindow("not-a-date", VERIFICATION_RESEND_MS)).toBe(false);
  });

  it("accepts a Date inside the window and rejects a stale one", () => {
    expect(withinWindow(new Date(Date.now() - 60_000), 3_600_000)).toBe(true);
    expect(withinWindow(new Date(Date.now() - 3_600_000), 3_600_000)).toBe(
      false,
    );
  });

  it("excludes the exact window edge", () => {
    // now - sent === window → the strict < must say false, not true.
    expect(withinWindow(new Date(Date.now() - 3_600_000), 3_600_000)).toBe(
      false,
    );
    // Just inside the edge is true.
    expect(withinWindow(new Date(Date.now() - 3_599_995), 3_600_000)).toBe(
      true,
    );
  });

  it("parses ISO strings as UTC instants", () => {
    expect(
      withinWindow(new Date(Date.now() - 60_000).toISOString(), 3_600_000),
    ).toBe(true);
    expect(
      withinWindow(
        new Date(Date.now() - 7 * 86_400_000).toISOString(),
        3_600_000,
      ),
    ).toBe(false);
  });

  it("parses wire-format timestamps (space separator) as UTC instants", () => {
    // Postgres TimestampString text, the on-disk shape for the columns
    // feeding the resend cooldowns. A local-time misparse would flip these
    // for any host west of UTC.
    expect(withinWindow(wireAgo(60_000), 3_600_000)).toBe(true);
    expect(withinWindow(wireAgo(7 * 86_400_000), 3_600_000)).toBe(false);
    // Cross-check the helper against toIso's UTC normalization: same
    // instant expressed both ways must agree.
    const sent = new Date(Date.now() - 120_000);
    expect(
      withinWindow(
        toIso(sent.toISOString().replace("T", " ").slice(0, 23)),
        3_600_000,
      ),
    ).toBe(withinWindow(sent, 3_600_000));
  });

  it("supports the resend-limit window size end to end", () => {
    // The once-per-day resend gate: fresh → still cooling down.
    expect(
      withinWindow(new Date(Date.now() - 60_000), VERIFICATION_RESEND_MS),
    ).toBe(true);
    expect(
      withinWindow(
        new Date(Date.now() - VERIFICATION_RESEND_MS),
        VERIFICATION_RESEND_MS,
      ),
    ).toBe(false);
  });
});
