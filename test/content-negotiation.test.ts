import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

/**
 * A URL has one representation. Nothing under app/ may pick its response type
 * from the request's Accept header, and nothing here may set a `Vary` header: a
 * shared cache keys on the URL, so a response selected by a request header
 * needs every cache in front of it to honour Vary, and the ones that do not
 * serve the wrong body to the next client. A route with several formats
 * publishes them as several URLs (the `.md` mirrors, `/llms.txt`) and
 * advertises them with links. (The server's own `Vary: Accept-Encoding` comes
 * from compression middleware, is not ours, and is correct caching; this scan
 * is about app sources.)
 *
 * The MCP endpoint's own protocol negotiation is in the SDK
 * (@modelcontextprotocol/server), not here, and those responses are
 * request-scoped and uncacheable. Anything else that genuinely must vary
 * belongs in ALLOWED with a comment saying why caching cannot apply to it.
 */
const ALLOWED: Record<string, string> = {};

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
