import { describe, expect, it } from "vitest";
import { RouterContextProvider } from "react-router";
import { middleware } from "~/root";

// GATE-REGR-1: the root gate once dropped /receipts-email-verify, and every
// emailed sender-verification link started bouncing to /login. The gate lives
// in route middleware now, so these pin the middleware: dropping an entry, or
// breaking the .data/.md suffix stripping, must fail here instead of in
// production email links. Whether a request reaches the route tree is exactly
// what the gate decides, so `next` stands in for the rest of the pipeline.

/** Run the gate the way React Router runs it: "passed" when the request
 * reached the route tree, otherwise the Response it threw. */
async function gate(path: string): Promise<Response | "passed"> {
  const request = new Request(`https://expense.test${path}`);
  const url = new URL(request.url);
  const call = middleware[0]!;
  try {
    await call(
      {
        request,
        url,
        pattern: url.pathname,
        params: {},
        context: new RouterContextProvider(),
      } as unknown as Parameters<typeof call>[0],
      async () => new Response("route", { status: 200 }),
    );
    return "passed";
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
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
  "/product-facts",
  "/alternatives",
  "/privacy",
  "/terms",
  "/support",
  "/llms.txt",
  "/auth.md",
  "/about.data",
  "/product-facts.data",
  "/product-facts.md",
  "/faq.md",
  "/privacy.md",
  "/terms.md",
  "/support.md",
];

// Resource routes that authenticate themselves. They used to be exempt from
// the gate by accident, because React Router runs no ancestor loader for one;
// now they have to be listed, so pin the list: an OAuth endpoint bounced to
// /login breaks the MCP client flow (a token request carries no cookie), and a
// bounced cron or webhook silently stops the email pipeline.
const SELF_GATED_PATHS = [
  "/mcp",
  "/mcp/server-card",
  "/sign-out",
  "/oauth/authorize",
  "/oauth/token",
  "/oauth/revoke",
  "/oauth/register",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/mcp",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/openid-configuration",
  "/.well-known/api-catalog",
  "/.well-known/ai-catalog.json",
  "/.well-known/mcp/server-card.json",
  "/.well-known/change-password",
  "/api/smoke",
  "/api/inbound-cron",
  "/api/email-connections-cron",
  "/api/email-connections-push",
  "/api/email-connections-gmail-push",
  "/api/inbound-push",
  "/api/dev-email-drain",
];

describe("root middleware gate (GATE-REGR-1)", () => {
  it.each(PUBLIC_PATHS)("stays reachable signed out: %s", async (path) => {
    await expect(gate(path)).resolves.toBe("passed");
  });

  it.each(SELF_GATED_PATHS)(
    "stays reachable signed out (self-gating route): %s",
    async (path) => {
      await expect(gate(path)).resolves.toBe("passed");
    },
  );

  it.each([
    "/settings",
    "/insights",
    "/expenses",
    "/export/all.zip",
    "/api/webmcp/expenses",
    "/mcp/tools",
  ])("redirects anonymous users from %s to /login", async (path) => {
    const result = await gate(path);
    expect(result).toBeInstanceOf(Response);
    const location = (result as Response).headers.get("Location") ?? "";
    expect(location.startsWith("/login")).toBe(true);
  });

  it("points the bounce at the page, not the .data fetch, so the post-login navigation lands on the route", async () => {
    const result = await gate("/settings.data?tab=account");
    const location = (result as Response).headers.get("Location") ?? "";
    expect(location).toBe(
      `/login?next=${encodeURIComponent("/settings?tab=account")}`,
    );
  });
});
