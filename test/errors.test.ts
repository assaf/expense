import { describe, it, expect, vi } from "vite-plus/test";

// errors.server imports @sentry/react-router, which drags in
// @opentelemetry/api, broken under vite-node's ESM resolution. Mock the
// Sentry module; captureError only reaches Sentry when isInitialized() is
// true, so the dedupe logic under test is unaffected.
vi.mock("@sentry/react-router", () => ({
  isInitialized: () => false,
  captureException: vi.fn(),
}));

import { captureErrorOnce, isRouterNoise } from "~/lib/errors.server";

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
