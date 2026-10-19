import { describe, expect, it } from "vite-plus/test";

/**
 * The installed-app contract. A Home Screen launch on iPhone drops the
 * Safari toolbars only when the page asks to be a standalone web app:
 * iOS 16.4+ reads the manifest's `display`, older releases read
 * `apple-mobile-web-app-capable`, and the status bar's own treatment comes
 * from its meta. The assertions read what the running server sends and what
 * the manifest declares, because that is what iOS reads — a source scan
 * would not catch a head that stopped rendering the tag.
 */
const baseURL = "http://localhost:5199";

/** The one <meta> tag with this name, whatever order the attributes are in. */
function metaTag(html: string, name: string): string | undefined {
  return html.match(new RegExp(`<meta[^>]*name="${name}"[^>]*>`))?.[0];
}

describe("installed web app", () => {
  it("asks iOS for a standalone launch in the document head", async () => {
    const res = await fetch(`${baseURL}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const head = html.slice(0, html.indexOf("</head>"));

    const capable = metaTag(head, "apple-mobile-web-app-capable");
    expect(capable).toBeDefined();
    expect(capable).toContain('content="yes"');

    // The status bar needs a style of its own: without one iOS keeps the
    // bar the Safari one.
    const statusBar = metaTag(head, "apple-mobile-web-app-status-bar-style");
    expect(statusBar).toBeDefined();
    expect(statusBar).toMatch(/content="(default|black|black-translucent)"/);

    // iOS takes the Home Screen icon from these, not from the manifest's
    // icon list alone.
    expect(head).toContain('rel="manifest"');
    expect(head).toContain('rel="apple-touch-icon"');
  });

  it("declares a standalone display and installable icons in the manifest", async () => {
    const res = await fetch(`${baseURL}/manifest.json`);
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as {
      name?: string;
      display?: string;
      icons?: Array<{ src: string; sizes: string }>;
    };

    expect(manifest.display).toBe("standalone");
    expect(manifest.name).toBeTruthy();
    const sizes = manifest.icons?.map((icon) => icon.sizes) ?? [];
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
  });
});
