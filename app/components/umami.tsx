import { useRouteLoaderData } from "react-router";

/**
 * The Umami analytics tag, rendered only on the public marketing and login
 * surfaces. Never rendered inside the signed-in app: tracking stops at the
 * front door, the account itself stays untracked. Pageview URLs exclude the
 * query string: emailed links carry single-use tokens in ?token=, and the
 * tracker must never record them. Values come from the root loader
 * (server-resolved, see umami.server.ts); inert until both are set.
 */
export function UmamiTag() {
  const data = useRouteLoaderData("root") as {
    umami?: { scriptUrl: string; websiteId: string };
  };
  const scriptUrl = data?.umami?.scriptUrl ?? "";
  const websiteId = data?.umami?.websiteId ?? "";
  if (!scriptUrl || !websiteId) return null;
  return (
    <script
      defer
      src={scriptUrl}
      data-website-id={websiteId}
      data-exclude-search="true"
    />
  );
}
