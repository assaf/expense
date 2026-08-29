import { UMAMI_SCRIPT_URL, UMAMI_WEBSITE_ID } from "~/lib/env";

/**
 * Umami analytics config, resolved server-side only (the `.server` suffix
 * keeps this module out of the client bundle; env.ts touches node:fs and
 * must never be imported from client code). The root loader ships it as
 * serialized loader data; the tag component renders from that.
 */
export const umamiConfig = {
  scriptUrl: UMAMI_SCRIPT_URL,
  websiteId: UMAMI_WEBSITE_ID,
};
