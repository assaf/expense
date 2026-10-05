import { describe, it, expect, vi } from "vite-plus/test";

// errors.server imports @sentry/react-router, which drags in
// @opentelemetry/api, broken under vite-node's ESM resolution. Mock the
// Sentry module; captureError only reaches Sentry when isInitialized() is
// true, so the dedupe logic under test is unaffected.
vi.mock("@sentry/react-router", () => ({
  isInitialized: () => false,
  captureException: vi.fn(),
}));

import {
  captureErrorOnce,
  errorSummary,
  isRouterNoise,
} from "~/lib/errors.server";

describe("captureErrorOnce", () => {
  it("reports each error object once no matter how many paths surface it", () => {
    const error = new Error("boom");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The stream onError fires first, then renderToReadableStream rejects
      // with the same object and handleError forwards it again, so the second
      // report must be a no-op.
      captureErrorOnce(error, { url: "/expense/1" });
      captureErrorOnce(error, { url: "/expense/1", method: "GET" });
      expect(spy).toHaveBeenCalledTimes(1);
      // Distinct errors still report.
      captureErrorOnce(new Error("other"));
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("errorSummary", () => {
  it("keeps the class and the first line, and nothing else", () => {
    expect(
      errorSummary(new Error("JMAP /api/query failed\n    at fetchAndDecode")),
    ).toBe("Error: JMAP /api/query failed");
  });

  it("masks what a secret scrubber would drop", () => {
    // A provider error quoting a response body is what makes Sentry replace
    // the whole value with [Filtered]; the summary has to survive that.
    const bearer = errorSummary(
      new Error("JMAP returned HTTP 401: Authorization: Bearer eyJhbGciOi"),
    );
    expect(bearer).not.toContain("eyJhbGciOi");
    expect(bearer).toContain("[redacted]");
    expect(
      errorSummary(new Error("refresh failed, token=abc123XYZ")),
    ).toContain("[redacted]");
    expect(
      errorSummary(
        new Error("auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjft1Z4CVP"),
      ),
    ).toContain("[redacted]");
  });

  it("masks the prefixed, quoted and suffixed secret names providers use", () => {
    // Three misses the adversarial pass found in the first version of this
    // mask, each a shape a real provider body carries:
    //  - `\b` never fires after `_`, so refresh_token / client_secret /
    //    access_token (this app's own OAuth field names) sailed past;
    //  - a JSON body puts a closing quote before the colon, so
    //    {"client_secret":"…"} matched nothing — the exact case the mask
    //    exists for, a provider error quoting its response body;
    //  - a suffix after the keyword (secret_key=, token_value=,
    //    password_hash=) is still a live secret.
    for (const message of [
      "token exchange failed: refresh_token=1//0eXaMpLe",
      "oauth error: client_secret: GOCSPX-abc123",
      'provider said {"access_token": "ya29.zzz999"}',
      'body was {"client_secret":"GOCSPX-abc123"}',
      "x-api-key=zzz999 rejected",
      "stripe said secret_key=sk_live_abc",
      "token_value=eyJhbGciOiJIUzI1NiJ9",
      "password_hash=$2b$12$abcdef",
      'password="two words"',
    ]) {
      const summary = errorSummary(new Error(message));
      expect(summary).toContain("[redacted]");
      expect(summary).not.toMatch(
        /(0eXaMpLe|GOCSPX|ya29|zzz999|sk_live|two words|\$2b\$12)/,
      );
    }
  });

  it("leaves ordinary prose alone and keeps the word before it", () => {
    // The match has to be zero-width: replacing one that starts at the
    // separator glues the words around it ("the[redacted] ratio").
    expect(errorSummary(new Error("the secret: sauce ratio"))).toBe(
      "Error: the [redacted] ratio",
    );
    expect(
      errorSummary(new Error("refresh failed, token=abc123XYZ")),
    ).toContain("refresh failed, [redacted]");
    for (const message of [
      "mytoken=keepme is not a secret",
      "the api-key rotation policy",
      "access_token_expires_at=1234",
    ]) {
      expect(errorSummary(new Error(message))).toContain(message);
    }
  });

  it("stays linear on a long non-credential line", () => {
    // The prefix run is bounded at six segments; unbounded it backtracks
    // quadratically on exactly this input (tens of seconds at 64k). The cap
    // is generous enough not to be machine-dependent and far below the
    // quadratic curve.
    const started = performance.now();
    errorSummary(new Error(`${"a_".repeat(50_000)}!`));
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("bounds the length and names a value that has no message", () => {
    expect(errorSummary(new Error("x".repeat(500)), 40)).toHaveLength(40);
    expect(errorSummary(new RangeError(""))).toBe("RangeError");
    expect(errorSummary("a thrown string")).toBe("string");
  });
});

describe("isRouterNoise", () => {
  it("drops what React Router throws at bots and scanners", () => {
    // Verbatim from production (EXPENSE-19): a scanner POSTed to "/", which
    // React Router routes to the root layout because an index route's action
    // is only targeted through the `index` search param, so it answered 405.
    expect(
      isRouterNoise({
        type: "Error",
        value:
          'You made a POST request to "/" but did not provide an `action` for route "root", so there is no way to handle the request.',
      }),
    ).toBe(true);
    expect(
      isRouterNoise({
        type: "Error",
        value:
          'You made a GET request to "/wp-login.php" but did not provide a `loader` for route "routes/wp-login", so there is no way to handle the request.',
      }),
    ).toBe(true);
    expect(
      isRouterNoise({ type: "Error", value: 'No route matches URL "/.env"' }),
    ).toBe(true);
    expect(
      isRouterNoise({ type: "NotFoundException", value: "Not Found" }),
    ).toBe(true);
  });

  it("keeps real failures", () => {
    expect(
      isRouterNoise({
        type: "Error",
        value: "connect ECONNREFUSED 127.0.0.1:5432",
      }),
    ).toBe(false);
    expect(
      isRouterNoise({
        type: "TypeError",
        value: "Cannot read properties of undefined (reading 'accountId')",
      }),
    ).toBe(false);
  });
});
