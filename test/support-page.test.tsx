import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { SUPPORT } from "~/lib/content.server";
import { SITE_URL } from "~/lib/seo-content";
import SupportPage, { meta } from "~/routes/support";

// This page is what Fastmail's app review opens and what a stuck user lands
// on, and it is the one public page outside the screenshot set: nothing else
// renders it. The plausible bug is not a clumsy sentence, it is the route
// copied from terms.tsx with the wrong canonical URL, or a section that stops
// rendering its paragraphs. Verified in a browser as well, but this runs in CI,
// where the screenshot comparisons do not.

/** The page as HTML, with the loader data the route's loader supplies. */
function renderSupport(): string {
  const props = {
    loaderData: SUPPORT,
  } as unknown as Parameters<typeof SupportPage>[0];
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/support"]}>
      <SupportPage {...props} />
    </MemoryRouter>,
  );
}

/** What the reader sees: tags removed and the entities React emits put back. */
function text(html: string): string {
  return html
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll(/\s+/g, " ")
    .trim();
}

describe("the support page", () => {
  it("renders every section with its paragraphs", () => {
    const body = text(renderSupport());
    for (const section of SUPPORT.sections) {
      expect(body).toContain(section.title);
      for (const paragraph of section.paragraphs) {
        expect(body).toContain(paragraph.map((s) => s.text).join(""));
      }
    }
  });

  it("points its canonical URL at /support", () => {
    const tags = meta({ loaderData: SUPPORT } as Parameters<typeof meta>[0]);
    expect(tags).toContainEqual({ title: SUPPORT.metaTitle });
    expect(tags).toContainEqual({
      name: "description",
      content: SUPPORT.description,
    });
    for (const tag of [
      { tagName: "link", rel: "canonical", href: `${SITE_URL}/support` },
      { property: "og:url", content: `${SITE_URL}/support` },
    ]) {
      expect(tags).toContainEqual(tag);
    }
  });

  it("leaves the reader an address to write to", () => {
    const html = renderSupport();
    expect(text(html)).toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);

    // The links in the copy are this site's pages, so they navigate in the
    // client: an absolute href here would make every one a full page load.
    for (const paragraph of SUPPORT.sections.flatMap((s) => s.paragraphs)) {
      for (const segment of paragraph) {
        if (!segment.href?.startsWith(`${SITE_URL}/`)) continue;
        expect(html).toContain(`href="${segment.href.slice(SITE_URL.length)}"`);
      }
    }
  });
});
