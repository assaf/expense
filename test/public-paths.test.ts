import { describe, expect, it } from "vitest";
import { loader } from "~/root";

// GATE-REGR-1: the root loader's public-path gate once dropped
// /receipts-email-verify, and every emailed sender-verification link
// started bouncing to /login. Pin the whole public list: removing an
// entry, or breaking the .data/.md suffix stripping, must fail here
// instead of in production email links.

function callLoader(path: string) {
  const request = new Request(`https://expense.test${path}`);
  return loader({
    request,
    params: {},
    context: {},
  } as Parameters<typeof loader>[0]);
}

const PUBLIC_PATHS = [
  "/",
  "/_.data",
  "/login",
  "/onboarding",
  "/reset-password",
  "/unsubscribe/abc123",
  "/receipts-email-verify?token=t",
  "/verify-email?token=t",
  "/connect-fastmail",
  "/fastmail-oauth-callback",
  "/connect-gmail",
  "/gmail-oauth-callback",
  "/about",
  "/ai",
  "/connect",
  "/faq",
  "/mileage-rates",
  "/schedule-c-categories",
  "/alternatives",
  "/llms.txt",
  "/about.data",
  "/faq.md",
];

describe("root loader public-path gate (GATE-REGR-1)", () => {
  it.each(PUBLIC_PATHS)("stays reachable signed out: %s", async (path) => {
    await expect(callLoader(path)).resolves.toBeTruthy();
  });

  it("redirects anonymous users from private pages to /login", async () => {
    const rejection = await callLoader("/expenses").then(
      () => null,
      (err: unknown) => err,
    );
    expect(rejection).toBeInstanceOf(Response);
    const location = (rejection as Response).headers.get("Location") ?? "";
    expect(location.startsWith("/login")).toBe(true);
  });
});
