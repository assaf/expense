import { describe, expect, it } from "vite-plus/test";
import {
  causesInclude,
  redactCredentials,
  stableForGrouping,
} from "~/lib/error-text";

/**
 * The three pure helpers every provider error passes through on its way to a
 * message. Each one has a way of being wrong that is invisible in review —
 * a mask that misses a shape leaks, a walk that stops early hides a class, a
 * collapse that is too eager erases the diagnosis — so they are pinned here
 * rather than only through the modules that use them.
 */

describe("redactCredentials", () => {
  it("masks an auth scheme with its value", () => {
    expect(redactCredentials("Authorization: Bearer ya29.abc")).not.toContain(
      "ya29.abc",
    );
    expect(redactCredentials("Basic dXNlcjpwYXNz")).toContain("[redacted]");
  });

  it("masks a credential in a query parameter", () => {
    // The shape this exists for: a Fastmail session document hands every
    // endpoint its credential in the URL, so a provider that echoes the token
    // it looked up would print it.
    const url = "https://api.fastmail.com/jmap/api/?access_token=t-abc123XYZ";
    const redacted = redactCredentials(url);
    expect(redacted).not.toContain("t-abc123XYZ");
    expect(redacted).toContain("[redacted]");
    // The endpoint itself is the useful half; it has to survive.
    expect(redacted).toContain("api.fastmail.com");
  });

  it("masks the quoted and suffixed secret names providers use", () => {
    for (const message of [
      'body was {"client_secret":"GOCSPX-abc123"}',
      "stripe said secret_key=sk_live_abc",
      "refresh failed, token=abc123XYZ",
      'x-api-key: "zzz999"',
      "password_hash=$2b$12$abcdef",
    ]) {
      const redacted = redactCredentials(message);
      expect(redacted).toContain("[redacted]");
      expect(redacted).not.toMatch(
        /(GOCSPX|sk_live|abc123XYZ|zzz999|\$2b\$12)/,
      );
    }
  });

  it("masks a JWT", () => {
    expect(
      redactCredentials(
        "auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjft1Z4CVP",
      ),
    ).not.toContain("dBjft1Z4CVP");
  });

  it("leaves ordinary prose alone", () => {
    for (const message of [
      "mytoken=keepme is not a secret",
      "the api-key rotation policy",
      "access_token_expires_at=1234",
      "Fastmail returned HTTP 401",
      "JMAP returned no method responses",
    ]) {
      expect(redactCredentials(message)).toBe(message);
    }
  });

  it("over-masks a keyword used as an ordinary word, keeping the spacing", () => {
    // Deliberate and pinned: the mask cannot tell "secret:" in prose from a
    // secret, and a false positive costs a word while a false negative costs
    // a credential. The replacement is zero-width in effect — it must not
    // glue the words around it ("the[redacted] ratio").
    expect(redactCredentials("the secret: sauce ratio")).toBe(
      "the [redacted] ratio",
    );
  });

  it("stays linear on a long line with no credential in it", () => {
    // The prefix run is bounded at six segments; unbounded it backtracks
    // quadratically on exactly this input (tens of seconds at 64k chars).
    const started = performance.now();
    redactCredentials(`${"a_".repeat(50_000)}!`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("causesInclude", () => {
  class Marker extends Error {}

  it("finds the class when it is thrown directly", () => {
    expect(causesInclude(new Marker("boom"), Marker)).toBe(true);
  });

  it("walks the cause chain", () => {
    // The shape the drain produces: each step re-throws a labelled error and
    // keeps the original as `cause`. A recognizer that stops at the wrapper
    // never sees the class, which is how a revoked grant once produced a
    const inner = new Error("drain:credential") as Error & { cause?: unknown };
    const outer = new Error("drain:reading") as Error & { cause?: unknown };
    outer.cause = inner;
    inner.cause = new Marker("provider said 401");
    expect(causesInclude(outer, Marker)).toBe(true);
  });

  it("returns false for a different class and for a non-Error", () => {
    class Other extends Error {}
    expect(causesInclude(new Other("x"), Marker)).toBe(false);
    expect(causesInclude("a thrown string", Marker)).toBe(false);
    expect(causesInclude(undefined, Marker)).toBe(false);
    expect(causesInclude(null, Marker)).toBe(false);
  });

  it("terminates on a self-referential chain", () => {
    const loop = new Error("loop") as Error & { cause?: unknown };
    loop.cause = loop;
    expect(causesInclude(loop, Marker)).toBe(false);
  });
});

describe("stableForGrouping", () => {
  it("collapses a provider trace id so one failure stays one issue", () => {
    // EXPENSE-1B: the drain stamps a per-request `ti_…` into every message,
    // so leaving it in would open a fresh Sentry issue per push instead of
    // accumulating onto the one the warn-on-transition guard counts.
    const first = stableForGrouping(
      'JMAP API failed: 401 {"trace_id":"ti_4d5aa79bdea5c53c8faeaf5faab72574"}',
    );
    const second = stableForGrouping(
      'JMAP API failed: 401 {"trace_id":"ti_cfd8a617ab572d8184872debccbc2c0f"}',
    );
    expect(first).toBe(second);
    expect(first).toContain('"trace_id":"<id>"');
  });

  it("collapses a hex id and a uuid", () => {
    expect(stableForGrouping("coupon_prefix=70c27857abcdef01")).toContain(
      "coupon_prefix=<id>",
    );
    expect(stableForGrouping("blob 3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(
      "blob <id>",
    );
  });

  it("keeps everything that makes the line worth reading", () => {
    const message =
      "Error: [email-connections] reading the mailbox failed: Error: JMAP API failed: 401";
    expect(stableForGrouping(message)).toBe(message);
  });
});
