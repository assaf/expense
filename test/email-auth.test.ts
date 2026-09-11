import { describe, expect, it } from "vitest";
import {
  evaluateAuthChain,
  evaluateAuthResults,
  passingAuthDomains,
} from "~/lib/email-auth.server";
import { authResultsChain, FASTMAIL_AUTHSERV } from "~/lib/mime-inbound.server";
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

describe("evaluateAuthChain", () => {
  it("allows a missing chain (legacy transport)", () => {
    expect(evaluateAuthChain([], "user@example.com").ok).toBe(true);
  });

  it("allows an all-empty chain as owner-internal mail", () => {
    // Fastmail stamps internal deliveries (same-account submission, or the
    // account's own redirect) without evaluating anything: no external hop
    // ever happened, which an outside sender cannot produce.
    const verdict = evaluateAuthChain(
      ["mx3.messagingengine.com;"],
      "assaf@labnotes.org",
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toContain("no external hop");
  });

  it("skips an empty newest stamp and evaluates the real one below it", () => {
    // External mail that the account redirected internally: the internal
    // leg prepends an empty stamp above the real first-delivery evaluation.
    const verdict = evaluateAuthChain(
      [
        "mx3.messagingengine.com;",
        "mx3.messagingengine.com; dmarc=pass header.from=example.com",
      ],
      "user@example.com",
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toContain("dmarc=pass");
  });

  it("ignores forged records below a failing genuine stamp (lookalike authserv-id)", () => {
    // Upstream A-R headers survive Fastmail's intake and a lookalike
    // authserv-id passes the collection filter, so an attacker's own SMTP
    // session can add a passing record below the genuine stamp. Only the
    // first clause-bearing record may be evaluated.
    const verdict = evaluateAuthChain(
      [
        "phl-mx-01.messagingengine.com; dkim=none; dmarc=fail header.from=example.com",
        "messagingengine.com.attacker.example; dkim=pass header.d=example.com",
      ],
      "user@example.com",
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("dmarc=fail");
  });

  it("ignores forged records below an empty newest stamp (internal redirect)", () => {
    // The internal-redirect chain: genuine entry evaluation below the
    // empty internal stamp, forged record below that. The entry record
    // decides; the forged one is never reached.
    const verdict = evaluateAuthChain(
      [
        "mx3.messagingengine.com;",
        "mx3.messagingengine.com; dkim=none; dmarc=fail header.from=example.com",
        "mx3.messagingengine.com.attacker.example; dkim=pass header.d=example.com",
      ],
      "user@example.com",
    );
    expect(verdict.ok).toBe(false);
  });
});

describe("passingAuthDomains (chains)", () => {
  it("uses the first clause-bearing record and skips empty stamps", () => {
    expect(
      passingAuthDomains([
        "mx3.messagingengine.com;",
        "mx3.messagingengine.com; dkim=pass header.d=fwd.example; dmarc=fail header.from=m.example",
      ]),
    ).toEqual(["fwd.example"]);
  });

  it("ignores passing domains in forged records below the genuine stamp", () => {
    expect(
      passingAuthDomains([
        "mx3.messagingengine.com; dkim=fail header.d=example.com",
        "messagingengine.com.attacker.example; dkim=pass header.d=example.com",
      ]),
    ).toEqual([]);
  });

  it("returns nothing for an all-empty chain", () => {
    expect(passingAuthDomains(["mx3.messagingengine.com;"])).toEqual([]);
  });
});

describe("authResultsChain (collection)", () => {
  const headers = [
    {
      key: "authentication-results",
      originalKey: "Authentication-Results",
      value: "phl-mx-01.messagingengine.com; dkim=pass header.d=example.com",
    },
    { key: "from", originalKey: "From", value: "Someone <user@example.com>" },
    {
      key: "authentication-results",
      originalKey: "Authentication-Results",
      value: "spf.icloud.com; spf=pass",
    },
    {
      key: "authentication-results",
      originalKey: "Authentication-Results",
      value:
        "mx.messagingengine.com.attacker.evil; dkim=pass header.d=example.com",
    },
  ];

  it("collects Fastmail-ish stamps newest-first and skips foreign authserv-ids", () => {
    // Document order (mailparser preserves it): Fastmail prepends each
    // stamp above existing headers, so index 0 is the newest delivery.
    expect(authResultsChain(headers, [FASTMAIL_AUTHSERV])).toEqual([
      "phl-mx-01.messagingengine.com; dkim=pass header.d=example.com",
      "mx.messagingengine.com.attacker.evil; dkim=pass header.d=example.com",
    ]);
  });

  it("includes lookalike authserv-ids (the substring filter is not a trust boundary)", () => {
    // This is WHY evaluateAuthChain must never walk past the first
    // clause-bearing record: a lookalike id survives ingestion and passes
    // this collection filter, so the evaluator's first-record rule is the
    // only defense (FWD-CHAIN-1).
    const chain = authResultsChain(headers, [FASTMAIL_AUTHSERV]);
    expect(chain[1]).toContain("attacker.evil");
  });
});

describe("evaluateAuthChain (real Fastmail stamp shapes)", () => {
  // Production redirected-receipt chains (captured from the live mailbox):
  // the host writes SEVERAL A-R headers per delivery, the topmost ones
  // carrying no dkim/spf/dmarc clauses at all (x-me-sender, bimi, arc).
  const SUBMISSION_CHAIN = [
    "phl-mx-08.messagingengine.com; x-csa=none; x-me-sender=pass policy.xms=S5d4",
    "phl-mx-08.messagingengine.com; bimi=skipped (DMARC Policy is not at enforcement)",
    "phl-mx-08.messagingengine.com; arc=none (no signatures found)",
    "phl-mx-08.messagingengine.com; dkim=pass (2048-bit rsa key sha256) header.d=labnotes.org header.i=@labnotes.org",
  ];

  it("passes a real redirected-receipt chain on its first recognized clause", () => {
    const verdict = evaluateAuthChain(SUBMISSION_CHAIN, "owner@labnotes.org");
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toContain("dkim=pass");
  });

  it("treats an all-x-me-sender chain as owner-internal mail", () => {
    // The actual INB-FWD-2 production shape: same-account submissions are
    // stamped but with no recognized method clauses anywhere.
    const verdict = evaluateAuthChain(
      [SUBMISSION_CHAIN[0], SUBMISSION_CHAIN[1]],
      "owner@labnotes.org",
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toContain("no external hop");
  });

  it("ignores a forged record appended below a real chain", () => {
    const verdict = evaluateAuthChain(
      [
        ...SUBMISSION_CHAIN,
        "messagingengine.com.attacker.example; dkim=pass header.d=labnotes.org",
      ],
      "owner@labnotes.org",
    );
    expect(verdict.ok).toBe(true);
    expect(
      passingAuthDomains([
        ...SUBMISSION_CHAIN,
        "messagingengine.com.attacker.example; dkim=pass header.d=other.example",
      ]),
    ).toEqual(["labnotes.org"]);
  });
});
