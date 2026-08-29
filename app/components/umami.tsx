import type { ReactElement } from "react";
import { UMAMI_SCRIPT_URL, UMAMI_WEBSITE_ID } from "~/lib/env";

/**
 * The Umami analytics tag, rendered only on the public marketing and login
 * surfaces. Never rendered inside the signed-in app: tracking stops at the
 * front door, the account itself stays untracked. Inert until both env vars
 * are set (UMAMI_SCRIPT_URL, UMAMI_WEBSITE_ID); without them nothing loads
 * and nothing is tracked.
 */
export function UmamiTag(): ReactElement | null {
  if (!UMAMI_SCRIPT_URL || !UMAMI_WEBSITE_ID) return null;
  return (
    <script defer src={UMAMI_SCRIPT_URL} data-website-id={UMAMI_WEBSITE_ID} />
  );
}
