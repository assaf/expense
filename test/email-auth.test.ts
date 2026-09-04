import { describe, expect, it } from "vitest";
import {
  evaluateAuthResults,
  passingAuthDomains,
} from "~/lib/email-auth.server";

/**
 * INB-SPOOF-1: the import gate's Authentication-Results evaluation. The
 * records mirror what Fastmail stamps on delivery (authserv-id
 * messagingengine.com; dkim/spf/dmarc with their identity params).
 */

const PASS_RECORD =
  "mx3.messagingengine.com; dkim=pass (2048-bit key) header.d=example.com header.i=@example.com; spf=pass smtp.mailfrom=bounce@example.com; dmarc=pass (p=none dis=none) header.from=example.com";

const SPOOF_RECORD =
  "mx3.messagingengine.com; dkim=pass header.d=attacker.evil; spf=pass smtp.mailfrom=bounce@attacker.evil; dmarc=fail (p=none) header.from=example.com";

describe("evaluateAuthResults", () => {
  it("allows a missing record (legacy transport)", () => {
    expect(evaluateAuthResults(null, "user@example.com").ok).toBe(true);
    expect(evaluateAuthResults(undefined, "user@example.com").ok).toBe(true);
  });

  it("passes on an aligned dmarc=pass", () => {
    const v = evaluateAuthResults(PASS_RECORD, "user@example.com");
    expect(v.ok).toBe(true);
    expect(v.reason).toContain("aligned with example.com");
  });

  it("passes on an aligned dkim=pass even when dmarc is absent", () => {
    const v = evaluateAuthResults(
      "mx3.messagingengine.com; dkim=pass header.d=example.com",
      "user@example.com",
    );
    expect(v.ok).toBe(true);
  });

  it("passes on an aligned spf=pass (org-domain subdomain alignment)", () => {
    const v = evaluateAuthResults(
      "mx3.messagingengine.com; spf=pass smtp.mailfrom=bounce@mail.example.com",
      "user@example.com",
    );
    expect(v.ok).toBe(true);
  });

  it("fails when the passing identity is a foreign domain (the spoof)", () => {
    const v = evaluateAuthResults(SPOOF_RECORD, "user@example.com");
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("attacker.evil");
    expect(v.reason).toContain("example.com");
  });

  it("fails when dmarc=pass was evaluated for a different From domain", () => {
    // Guards against a record that was evaluated for another message.
    const v = evaluateAuthResults(
      "mx3.messagingengine.com; dmarc=pass header.from=other.org",
      "user@example.com",
    );
    expect(v.ok).toBe(false);
  });

  it("fails when the record shows no passing method", () => {
    const v = evaluateAuthResults(
      "mx3.messagingengine.com; dkim=fail; spf=softfail smtp.mailfrom=x@other.org",
      "user@example.com",
    );
    expect(v.ok).toBe(false);
  });

  it("rejects a multi-dkim record where a failing aligned clause precedes a passing foreign one (the cross-pairing bypass)", () => {
    // Two DKIM signatures: a bogus one claiming the From domain (fails
    // evaluation) plus a valid attacker-domain one (passes). Strict
    // per-clause evaluation must not let the failing clause's aligned
    // domain borrow the later clause's pass.
    const v = evaluateAuthResults(
      "mx3.messagingengine.com; dkim=fail header.d=victim.example; dkim=pass header.d=attacker.evil; spf=pass smtp.mailfrom=bounce@attacker.evil; dmarc=fail header.from=victim.example",
      "user@victim.example",
    );
    expect(v.ok).toBe(false);
  });

  it("rejects the reverse multi-dkim order (pass foreign first, aligned fail second)", () => {
    const v = evaluateAuthResults(
      "mx3.messagingengine.com; dkim=pass header.d=attacker.evil; dkim=fail header.d=victim.example",
      "user@victim.example",
    );
    expect(v.ok).toBe(false);
  });

  it("accepts a legitimate multi-signature record (aligned clause present)", () => {
    const v = evaluateAuthResults(
      "mx3.messagingengine.com; dkim=pass header.d=example.com; dkim=pass header.d=maillist.example.com",
      "user@example.com",
    );
    expect(v.ok).toBe(true);
  });

  it("fails on an unparseable record", () => {
    expect(evaluateAuthResults(";;;", "user@example.com").ok).toBe(false);
  });

  it("fails when the From has no domain", () => {
    expect(evaluateAuthResults(PASS_RECORD, "no-domain").ok).toBe(false);
  });
});

describe("passingAuthDomains (INB-FWD-1 input)", () => {
  // The forward path matches these against verified sender domains: a
  // client-side forward keeps the ORIGINAL sender in From (dmarc=fail
  // header.from=merchant), while the passing clauses carry the FORWARDER's
  // domain.
  const FORWARDED_RECORD =
    "mx3.messagingengine.com; dkim=pass header.d=forwarder.example; spf=pass smtp.mailfrom=bounce@forwarder.example; dmarc=fail (p=none) header.from=merchant.example";

  it("collects domains from passing clauses only", () => {
    expect(passingAuthDomains(FORWARDED_RECORD)).toEqual(["forwarder.example"]);
  });

  it("collects domains from every passing method", () => {
    const record =
      "mx; dkim=pass header.d=a.example; spf=pass smtp.mailfrom=b@b.example; dmarc=pass header.from=c.example";
    expect(passingAuthDomains(record).sort()).toEqual([
      "a.example",
      "b.example",
      "c.example",
    ]);
  });

  it("returns nothing when every clause fails", () => {
    expect(
      passingAuthDomains(
        "mx; dkim=fail header.d=a.example; dmarc=fail header.from=b.example",
      ),
    ).toEqual([]);
  });

  it("returns nothing for a missing or unparseable record", () => {
    expect(passingAuthDomains(null)).toEqual([]);
    expect(passingAuthDomains(";;;")).toEqual([]);
  });
});
