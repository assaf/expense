/** The structured-data script tag: every marketing page hands its own
 * schema object to this wrapper, so the tag itself (its type, and how the
 * JSON is emitted) lives in one place instead of being respelled per page. */
export function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json">{JSON.stringify(data)}</script>;
}
