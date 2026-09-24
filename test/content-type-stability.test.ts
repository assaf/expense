import { describe, expect, it } from "vite-plus/test";

/**
 * The HTTP-level half of the one-representation rule: a URL answers the same
 * status and content type whatever the client's Accept says. The source scan
 * in test/content-negotiation.test.ts keeps our own code honest; this checks
 * what the running server actually sends, dependencies included (an SDK or a
 * middleware that started setting `Vary: Accept` would slip past a scan of
 * app/).
 *
 * The sample is one endpoint per response kind, plus an auth-gated page (the
 * gate redirects before any route runs, and it must not be Accept-aware
 * either).
 */
const baseURL = "http://localhost:5199";

const PATHS = [
  "/about", // marketing HTML, with a markdown mirror beside it
  "/about.md", // the mirror, as its own URL
  "/llms.txt", // plain text
  "/sitemap.xml", // XML
  "/mcp", // the MCP endpoint (JSON, and the SDK's own transport)
  "/login", // app HTML
  "/expenses", // auth-gated: the gate redirects, then /login answers
];

const ACCEPTS = [
  "text/html,application/xhtml+xml",
  "*/*",
  "text/markdown",
  "application/json",
  "text/html;q=0.1, text/markdown;q=0.9",
];

/** The parts of a response that must not depend on Accept. */
async function probe(
  path: string,
  accept: string,
): Promise<{ status: number; type: string | null; vary: string[] }> {
  const res = await fetch(`${baseURL}${path}`, { headers: { Accept: accept } });
  await res.arrayBuffer(); // drain, so the connection is reusable
  return {
    status: res.status,
    type: res.headers.get("content-type"),
    vary: (res.headers.get("vary") ?? "")
      .toLowerCase()
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean),
  };
}

describe("a URL has one representation", () => {
  it("answers the same status and content type for any Accept", async () => {
    for (const path of PATHS) {
      const baseline = await probe(path, "*/*");
      // A response with no content type would make the comparison vacuous.
      expect(
        baseline.type,
        `${path} answered without a content type`,
      ).toBeTruthy();
      for (const accept of ACCEPTS) {
        const got = await probe(path, accept);
        expect(
          { status: got.status, type: got.type },
          `${path} answered differently for Accept: ${accept}`,
        ).toEqual({ status: baseline.status, type: baseline.type });
      }
    }
  });

  it("never varies on Accept (Accept-Encoding from compression is fine)", async () => {
    for (const path of PATHS) {
      const { vary } = await probe(path, "text/markdown");
      expect(vary, `${path} varies on Accept`).not.toContain("accept");
    }
  });
});
