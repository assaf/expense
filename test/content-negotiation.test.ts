import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

/**
 * One representation per URL, with one deliberate exception: the marketing
 * pages also answer `Accept: text/markdown` (markdown-negotiation.server.ts,
 * applied by the root middleware), because that is how an agent asks for a
 * page and Cloudflare calls it "Markdown for Agents". Both representations
 * carry `Vary: Accept`, so a cache that honours Vary serves the right one;
 * a cache that ignores it is no worse off than the HTML it already had.
 *
 * Everything else stays one representation. Nothing under app/ may pick its
 * response type from the request's Accept header, and nothing may set a `Vary`
 * header. A route with several formats publishes them as several URLs (the
 * `.md` mirrors, `/llms.txt`) and advertises them with links.
 *
 * The MCP endpoint's own protocol negotiation is in the SDK
 * (@modelcontextprotocol/server), not here, and those responses are
 * request-scoped and uncacheable. Anything else that genuinely must vary
 * belongs in ALLOWED with a comment saying why caching cannot apply to it.
 */
const ALLOWED: Record<string, string> = {
  // /mcp redirects a BROWSER (Accept: text/html) to the /connect guide. The
  // redirect is Cache-Control: no-store and Vary: Accept, so no shared cache
  // ever stores it, and MCP clients (application/json, text/event-stream)
  // never send text/html — the endpoint they reach is byte-identical
  // whatever the Accept says.
  "app/routes/mcp.ts": "no-store redirect for browsers only",
  // Markdown for Agents: the one negotiated pair, both sides named. The
  // module picks the markdown representation; the middleware puts Vary on the
  // HTML one too, so neither can be served to the wrong client by a cache.
  "app/lib/markdown-negotiation.server.ts": "negotiated markdown for agents",
  "app/root.tsx": "adds Vary: Accept to the negotiated pages",
};

describe("content type never depends on Accept", () => {
  it("no app source reads the Accept header or varies on it", () => {
    const offenders: string[] = [];
    for (const path of globSync("app/**/*.{ts,tsx}")) {
      if (ALLOWED[path]) continue;
      const lines = readFileSync(path, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        const code = line.trim();
        if (code.startsWith("*") || code.startsWith("//")) continue;
        if (/headers\.get\(\s*["'`]accept["'`]\s*\)/i.test(code)) {
          offenders.push(`${path}:${index + 1} reads the Accept header`);
        }
        // `Vary:` / "Vary" — a header, not the verb ("prices vary by…").
        if (/\bvary\s*:/i.test(code) || /["'`]vary["'`]/i.test(code)) {
          offenders.push(`${path}:${index + 1} sets a Vary header`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
