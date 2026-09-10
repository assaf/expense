import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevBadge } from "~/root";

// The badge's whole contract is its gate: it must mark the dev server
// (NODE_ENV=development) and never leak into production builds or the
// test/screenshot servers (NODE_ENV=production/test — a stray badge in
// prod is the plausible bug this pins).

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("DevBadge (dev-mode corner marker)", () => {
  it("renders a fixed top-left marker on the dev server", () => {
    vi.stubEnv("NODE_ENV", "development");
    const html = renderToStaticMarkup(<DevBadge />);
    expect(html).toContain("DEV");
    // Pinned to the viewport corner, above content, inert to input.
    expect(html).toContain("fixed");
    expect(html).toContain("left-0");
    expect(html).toContain("top-0");
    expect(html).toContain("pointer-events-none");
    expect(html).toContain('aria-hidden="true"');
  });

  it("renders nothing in production and test environments", () => {
    for (const env of ["production", "test"] as const) {
      vi.stubEnv("NODE_ENV", env);
      expect(renderToStaticMarkup(<DevBadge />)).toBe("");
    }
  });
});
