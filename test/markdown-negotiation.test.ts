import { expect } from "playwright/test";
import type { Page } from "playwright";
import { afterAll, describe, it } from "vite-plus/test";
import { aboutMarkdown, landingMarkdown } from "~/lib/content.server";
import {
  NEGOTIATED_PATHS,
  negotiateMarkdown,
  wantsMarkdown,
} from "~/lib/markdown-negotiation.server";
import { closeBrowser, freshPage } from "./helpers/launchBrowser";

const BASE = "http://localhost:5199";

/** A request as the middleware would see it; the origin never matters. */
const request = (path: string, accept: string | null, method = "GET") =>
  new Request(`https://expense.labnotes.org${path}`, {
    method,
    headers: accept === null ? {} : { Accept: accept },
  });

/** The Accept string Chrome actually sends. */
const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

/** A Vary value as tokens. The platform appends Accept-Encoding for
 * compression, so Accept has to be compared as a token: a substring test
 * would pass on Accept-Encoding alone. */
const varyTokens = (value: string) => value.split(",").map((v) => v.trim());

describe("Markdown for Agents", () => {
  afterAll(async () => {
    await closeBrowser();
  });

  it("negotiates only on an explicit text/markdown", () => {
    // HTML stays the default: a browser, curl's wildcard, and no header at
    // all never get the markdown document.
    expect(wantsMarkdown(request("/", BROWSER_ACCEPT))).toBe(false);
    expect(wantsMarkdown(request("/", "*/*"))).toBe(false);
    expect(wantsMarkdown(request("/", null))).toBe(false);
    expect(wantsMarkdown(request("/", "text/markdown"))).toBe(true);
    expect(wantsMarkdown(request("/", "text/markdown, text/html;q=0.9"))).toBe(
      true,
    );
    expect(wantsMarkdown(request("/", "TEXT/MARKDOWN"))).toBe(true);
    // An explicit refusal is not a request.
    expect(wantsMarkdown(request("/", "text/markdown;q=0"))).toBe(false);
  });

  it("returns the page's markdown with the agent headers", () => {
    const response = negotiateMarkdown(request("/about", "text/markdown"));
    if (response === null) throw new Error("expected a negotiated response");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    // The URL now has two representations, so caches must key on Accept.
    expect(response.headers.get("vary")).toBe("Accept");
    expect(Number(response.headers.get("x-markdown-tokens"))).toBeGreaterThan(
      0,
    );
  });

  it("negotiates nothing it has no representation for", async () => {
    // A private path must fall through to the gate, not be answered here.
    expect(negotiateMarkdown(request("/expenses", "text/markdown"))).toBeNull();
    // The .md mirror is its own resource route, and POST is not a page read.
    expect(negotiateMarkdown(request("/about.md", "text/markdown"))).toBeNull();
    expect(
      negotiateMarkdown(request("/about", "text/markdown", "POST")),
    ).toBeNull();
    // Every listed path really has a body.
    for (const path of NEGOTIATED_PATHS) {
      const response = negotiateMarkdown(request(path, "text/markdown"));
      if (response === null) throw new Error(`${path} has no markdown`);
      expect((await response.text()).length, path).toBeGreaterThan(0);
    }
  });

  it("serves markdown from the page URL and HTML by default", async () => {
    const page: Page = await freshPage();

    const negotiated = await page.request.get(`${BASE}/about`, {
      headers: { Accept: "text/markdown" },
    });
    expect(negotiated.status()).toBe(200);
    expect(negotiated.headers()["content-type"]).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(varyTokens(negotiated.headers()["vary"])).toContain("Accept");
    expect(await negotiated.text()).toBe(aboutMarkdown());

    const html = await page.request.get(`${BASE}/about`);
    expect(html.headers()["content-type"]).toContain("text/html");
    expect(varyTokens(html.headers()["vary"])).toContain("Accept");

    // The site root is what the scanner asks for: it has no .md mirror, so
    // this is the only way an agent gets it as markdown.
    const root = await page.request.get(`${BASE}/`, {
      headers: { Accept: "text/markdown" },
    });
    expect(root.headers()["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(await root.text()).toBe(landingMarkdown());

    await page.close();
  });

  it("keeps every negotiated path public and leaves the gate alone", async () => {
    const page = await freshPage();

    // Negotiation runs before the session gate, so a path that is not public
    // would be a bypass. Each one must answer an ordinary browser with HTML.
    for (const path of NEGOTIATED_PATHS) {
      const response = await page.request.get(`${BASE}${path}`, {
        headers: { Accept: BROWSER_ACCEPT },
        maxRedirects: 0,
      });
      expect(response.status(), path).toBe(200);
      expect(response.headers()["content-type"], path).toContain("text/html");
    }

    // A private page asked for as markdown still redirects to the login.
    const gated = await page.request.get(`${BASE}/expenses`, {
      headers: { Accept: "text/markdown" },
      maxRedirects: 0,
    });
    expect(gated.status()).toBe(302);
    expect(gated.headers()["location"]).toContain("/login");

    // /login shares the header helper but is not in the map: it stays HTML,
    // and it must not claim to vary on Accept either.
    const login = await page.request.get(`${BASE}/login`, {
      headers: { Accept: "text/markdown" },
    });
    expect(login.headers()["content-type"]).toContain("text/html");
    expect(varyTokens(login.headers()["vary"] ?? "")).not.toContain("Accept");

    await page.close();
  });
});
