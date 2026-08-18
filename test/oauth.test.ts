import { expect } from "playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { generateCodeVerifier, pkceChallenge } from "~/lib/oauth.server";
import { freezePageClock, signIn } from "./helpers/launchBrowser";
import { TEST_EMAIL, TEST_PASSWORD, testPrisma } from "./helpers/seedTestData";

const baseURL = "http://localhost:5199";
const CALLBACK = "http://127.0.0.1:5199/callback";

/**
 * End-to-end tests for the MCP OAuth authorization server: dynamic client
 * registration, the authorization-code + PKCE flow through the real consent
 * page, token exchange, refresh rotation, revocation, and using the access
 * token on /mcp.
 */
describe("MCP OAuth", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    // Clients cascade to their codes, tokens, and consents.
    await testPrisma.oAuthClient.deleteMany({
      where: { name: { startsWith: "oauth-test" } },
    });
  });

  async function registerClient(name: string): Promise<string> {
    const res = await fetch(`${baseURL}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: name,
        redirect_uris: [CALLBACK],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { client_id: string };
    expect(body.client_id).toBeTruthy();
    return body.client_id;
  }

  function authorizeUrl(
    clientId: string,
    verifier: string,
    state = "state-123",
  ): string {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      state,
    });
    return `${baseURL}/oauth/authorize?${params}`;
  }

  /** Sign in through the real login form and return the page. */
  async function signedInPage(email: string, password: string): Promise<Page> {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await freezePageClock(page);
    await signIn(page, email, password);
    return page;
  }

  /**
   * Run the authorize flow in the browser. The consent page always appears
   * (the GET never issues codes silently) — we click Allow/Deny and expect
   * the redirect back to the callback with a code or error.
   */
  async function runAuthorize(
    page: Page,
    url: string,
    decision: "approve" | "deny",
  ): Promise<URL> {
    await page.goto(url, { waitUntil: "load", timeout: 15_000 });
    const consent = page.getByRole("button", {
      name: decision === "approve" ? "Allow" : "Deny",
    });
    if (await consent.isVisible().catch(() => false)) {
      await consent.click();
    }
    await page.waitForURL(
      (u) => u.searchParams.has("code") || u.searchParams.has("error"),
      {
        timeout: 15_000,
      },
    );
    return new URL(page.url());
  }

  async function exchangeCode(
    body: Record<string, string>,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${baseURL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
  }

  // --- MCP JSON-RPC helpers (mirror mcp.test.ts, token-parameterized) ------

  async function mcpPost(
    token: string,
    body: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${baseURL}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  /** 2025-era handshake (served statelessly — no session id is issued). */
  async function initialize(token: string): Promise<void> {
    const init = await mcpPost(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "oauth-test", version: "1.0.0" },
      },
    });
    expect(init.status).toBe(200);
  }

  async function callTool(
    token: string,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const res = await mcpPost(token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    });
    expect(res.status).toBe(200);
    const result = (res.json as { result: { content: { text: string }[] } })
      .result;
    return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  }

  // --- Tests ---------------------------------------------------------------

  it("serves OAuth discovery metadata", async () => {
    const res = await fetch(
      `${baseURL}/.well-known/oauth-authorization-server`,
    );
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.issuer).toBe(new URL(baseURL).origin);
    expect(meta.authorization_endpoint).toContain("/oauth/authorize");
    expect(meta.token_endpoint).toContain("/oauth/token");
    expect(meta.registration_endpoint).toContain("/oauth/register");
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("rejects registration with a non-loopback http redirect URI", async () => {
    const res = await fetch(`${baseURL}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "oauth-test-bad",
        redirect_uris: ["http://evil.example/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("runs the full authorization-code + PKCE flow and uses the token on /mcp", async () => {
    const clientId = await registerClient("oauth-test-app");
    const verifier = generateCodeVerifier();
    const page = await signedInPage(TEST_EMAIL, TEST_PASSWORD);

    const redirected = await runAuthorize(
      page,
      authorizeUrl(clientId, verifier),
      "approve",
    );
    expect(redirected.searchParams.get("state")).toBe("state-123");
    const code = redirected.searchParams.get("code");
    expect(code).toBeTruthy();

    const exchanged = await exchangeCode({
      grant_type: "authorization_code",
      code: code!,
      code_verifier: verifier,
      redirect_uri: CALLBACK,
      client_id: clientId,
    });
    expect(exchanged.status).toBe(200);
    const accessToken = exchanged.json.access_token as string;
    const refreshToken = exchanged.json.refresh_token as string;
    expect(accessToken).toMatch(/^oat_/);
    expect(refreshToken).toMatch(/^ort_/);

    const expenses = await callTool(accessToken, "list_expenses", {});
    // Scoped to the signing-in user's account (Test Account), not the other.
    const list = expenses as { expenses: { merchant: string }[] };
    expect(list.expenses.length).toBeGreaterThan(0);
    expect(list.expenses.some((e) => e.merchant === "Secret Corp")).toBe(false);
  });

  it("requires explicit approval on every connection (no silent codes)", async () => {
    const clientId = await registerClient("oauth-test-remember");
    const verifier = generateCodeVerifier();
    const page = await signedInPage(TEST_EMAIL, TEST_PASSWORD);

    await runAuthorize(page, authorizeUrl(clientId, verifier), "approve");
    // A second connection must show the consent page again — the authorize
    // GET never issues a code without an Allow click, so a link or image
    // request from an attacker page can't silently mint a code for an
    // already-approved client (consent-CSRF).
    const secondUrl = authorizeUrl(clientId, verifier, "state-456");
    await page.goto(secondUrl, { waitUntil: "load", timeout: 15_000 });
    const allow = page.getByRole("button", { name: "Allow" });
    expect(await allow.isVisible().catch(() => false)).toBe(true);
    await allow.click();
    await page.waitForURL((u) => u.searchParams.has("code"), {
      timeout: 15_000,
    });
    const redirected = new URL(page.url());
    expect(redirected.searchParams.get("code")).toBeTruthy();
    expect(redirected.searchParams.get("state")).toBe("state-456");
  });

  it("frames out the consent page (clickjacking protection)", async () => {
    const clientId = await registerClient("oauth-test-framing");
    const verifier = generateCodeVerifier();
    const page = await signedInPage(TEST_EMAIL, TEST_PASSWORD);
    const res = await page.request.get(authorizeUrl(clientId, verifier));
    expect(res.status()).toBe(200);
    const headers = res.headers();
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    await page.close();
  });

  it("denies the connection when the user clicks Deny", async () => {
    const clientId = await registerClient("oauth-test-deny");
    const verifier = generateCodeVerifier();
    const page = await signedInPage(TEST_EMAIL, TEST_PASSWORD);

    const redirected = await runAuthorize(
      page,
      authorizeUrl(clientId, verifier, "state-deny"),
      "deny",
    );
    expect(redirected.searchParams.get("error")).toBe("access_denied");
    expect(redirected.searchParams.get("state")).toBe("state-deny");
    expect(redirected.searchParams.get("code")).toBeNull();
  });

  it("rejects a code exchanged with the wrong PKCE verifier, and re-use", async () => {
    const clientId = await registerClient("oauth-test-pkce");
    const page = await signedInPage(TEST_EMAIL, TEST_PASSWORD);

    // Fresh authorize (consent was granted above for this client? no — new
    // client, so approve again), then exchange with a wrong verifier.
    const verifier = generateCodeVerifier();
    const redirected = await runAuthorize(
      page,
      authorizeUrl(clientId, verifier),
      "approve",
    );
    const code = redirected.searchParams.get("code")!;

    const wrong = await exchangeCode({
      grant_type: "authorization_code",
      code,
      code_verifier: generateCodeVerifier(), // different verifier
      redirect_uri: CALLBACK,
      client_id: clientId,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error).toBe("invalid_grant");

    // The code was consumed by the failed attempt? No — PKCE fails before
    // issue, but the code was claimed (single-use). Reuse must fail either way.
    const reuse = await exchangeCode({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: CALLBACK,
      client_id: clientId,
    });
    expect(reuse.status).toBe(400);
    expect(reuse.json.error).toBe("invalid_grant");
  });

  it("rotates refresh tokens and rejects the old one", async () => {
    const clientId = await registerClient("oauth-test-refresh");
    const verifier = generateCodeVerifier();
    const page = await signedInPage(TEST_EMAIL, TEST_PASSWORD);
    const redirected = await runAuthorize(
      page,
      authorizeUrl(clientId, verifier),
      "approve",
    );
    const code = redirected.searchParams.get("code")!;

    const first = await exchangeCode({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: CALLBACK,
      client_id: clientId,
    });
    const oldRefresh = first.json.refresh_token as string;

    const rotated = await exchangeCode({
      grant_type: "refresh_token",
      refresh_token: oldRefresh,
      client_id: clientId,
    });
    expect(rotated.status).toBe(200);
    const newAccess = rotated.json.access_token as string;
    const newRefresh = rotated.json.refresh_token as string;
    expect(newAccess).toMatch(/^oat_/);
    expect(newRefresh).not.toBe(oldRefresh);

    // The rotated refresh token works on /mcp.
    await initialize(newAccess);

    // The old refresh token is dead.
    const replay = await exchangeCode({
      grant_type: "refresh_token",
      refresh_token: oldRefresh,
      client_id: clientId,
    });
    expect(replay.status).toBe(400);
    expect(replay.json.error).toBe("invalid_grant");
  });

  it("revokes tokens and disconnects the client", async () => {
    const clientId = await registerClient("oauth-test-revoke");
    const verifier = generateCodeVerifier();
    const page = await signedInPage(TEST_EMAIL, TEST_PASSWORD);
    const redirected = await runAuthorize(
      page,
      authorizeUrl(clientId, verifier),
      "approve",
    );
    const code = redirected.searchParams.get("code")!;
    const exchanged = await exchangeCode({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: CALLBACK,
      client_id: clientId,
    });
    const accessToken = exchanged.json.access_token as string;
    const refreshToken = exchanged.json.refresh_token as string;

    // Access token works before revocation.
    await initialize(accessToken);

    const revoke = await fetch(`${baseURL}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: accessToken, client_id: clientId }),
    });
    expect(revoke.status).toBe(200);

    const denied = await mcpPost(accessToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    expect(denied.status).toBe(401);

    // Revoking the access token does NOT revoke the refresh token (RFC 7009)
    // — the refresh grant still works.
    const stillAlive = await exchangeCode({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });
    expect(stillAlive.status).toBe(200);

    // Revoking the refresh token kills the grant.
    const revokeRefresh = await fetch(`${baseURL}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken, client_id: clientId }),
    });
    expect(revokeRefresh.status).toBe(200);
    const dead = await exchangeCode({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });
    expect(dead.status).toBe(400);
  });

  it("keeps users' connections isolated per account", async () => {
    const clientId = await registerClient("oauth-test-isolation");
    const verifier = generateCodeVerifier();
    const page = await signedInPage("otheruser@example.com", "other-password");
    const redirected = await runAuthorize(
      page,
      authorizeUrl(clientId, verifier),
      "approve",
    );
    const code = redirected.searchParams.get("code")!;
    const exchanged = await exchangeCode({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: CALLBACK,
      client_id: clientId,
    });
    const accessToken = exchanged.json.access_token as string;

    const expenses = await callTool(accessToken, "list_expenses", {});
    const list = expenses as { expenses: { merchant: string }[] };
    expect(list.expenses.length).toBe(1);
    expect(list.expenses[0]!.merchant).toBe("Secret Corp");
  });

  it("advertises the public origin behind a TLS-terminating proxy", async () => {
    // A proxy terminates TLS: the app sees http + x-forwarded-proto: https.
    const headers = {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "expense.localhost",
    };
    const metaRes = await fetch(
      `${baseURL}/.well-known/oauth-authorization-server`,
      { headers },
    );
    const meta = (await metaRes.json()) as Record<string, string>;
    expect(meta.issuer).toBe("https://expense.localhost");
    expect(meta.authorization_endpoint).toBe(
      "https://expense.localhost/oauth/authorize",
    );

    const resourceRes = await fetch(
      `${baseURL}/.well-known/oauth-protected-resource`,
      { headers },
    );
    const resource = (await resourceRes.json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(resource.resource).toBe("https://expense.localhost/mcp");
    expect(resource.authorization_servers).toEqual([
      "https://expense.localhost",
    ]);

    // And the /mcp 401 WWW-Authenticate hint carries the public origin too.
    const mcpRes = await fetch(`${baseURL}/mcp`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });
    expect(mcpRes.status).toBe(401);
    expect(mcpRes.headers.get("www-authenticate")).toContain(
      "https://expense.localhost/.well-known/oauth-protected-resource",
    );
  });

  it("advertises the protected resource on unauthenticated /mcp 401s", async () => {
    const res = await fetch(`${baseURL}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate") ?? "";
    expect(wwwAuth).toContain("oauth-protected-resource");
  });
});
