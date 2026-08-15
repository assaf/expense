import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard + guarded fetch for server-side requests to URLs that may be
 * supplied by an untrusted party (the MCP `capture_receipt` url argument,
 * `<img src>` URLs inside forwarded email HTML).
 *
 * `fetchPublicUrl` only follows http(s), rejects private/unresolvable hosts
 * (literal address AND DNS-resolved — a public-looking hostname that
 * resolves to 10.x or 169.254.169.254 is blocked), and follows redirects
 * manually with the same checks at every hop, so a redirect chain can never
 * smuggle the request to an internal address.
 */

/** Error thrown by `fetchPublicUrl` when a URL is invalid, blocked, or
 * unreadable. The message is safe to surface to callers. */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

/** Maximum redirects followed; every hop is re-checked. */
const MAX_REDIRECTS = 3;

/** True when a hostname (literal or name) points at a private, loopback,
 * link-local, or otherwise non-routable address. Hostnames that are not
 * literal IPs return false here — `isPrivateUrl` resolves those and checks
 * every resulting address. */
export function isPrivateHost(hostname: string): boolean {
  let h = hostname.toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1); // "[::1]"
  if (h === "localhost" || h === "localhost.localdomain") return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true; // IPv6 loopback
  if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) {
    return true; // IPv6 link-local / unique-local
  }
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) — check the embedded address.
  const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const ipv4 = (mapped ? mapped[1] : h).match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
  );
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/**
 * True when a URL would reach a private or unresolvable address: the
 * literal host is checked first, then the hostname is resolved and every
 * A/AAAA record is checked (a rebinding-friendly hostname with any private
 * record is rejected). Fails closed — unresolvable hostnames are private.
 * `lookupFn` is injectable for tests.
 */
export async function isPrivateUrl(
  url: URL,
  lookupFn: typeof lookup = lookup,
): Promise<boolean> {
  if (url.protocol !== "https:" && url.protocol !== "http:") return true;
  if (isPrivateHost(url.hostname)) return true;
  if (isIP(url.hostname)) return isPrivateHost(url.hostname);
  try {
    const addresses = await lookupFn(url.hostname, {
      all: true,
      verbatim: true,
    });
    return addresses.some(({ address }) => isPrivateHost(address));
  } catch {
    return true;
  }
}

/** Options for `fetchPublicUrl`. */
export interface PublicFetchOptions {
  /** Abort timeout per hop (default 10s). */
  timeoutMs?: number;
  /** Max redirects followed, each re-checked (default 3). */
  redirects?: number;
}

/** Fetch a user-supplied URL with SSRF guards, following redirects manually
 * (same checks at every hop). Throws SsrfError on any invalid, blocked, or
 * failed request. The response is NOT size-limited here — callers bound the
 * body per use case. */
export async function fetchPublicUrl(
  input: string | URL,
  options: PublicFetchOptions = {},
  lookupFn: typeof lookup = lookup,
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const redirects = options.redirects ?? MAX_REDIRECTS;
  let current: URL;
  try {
    current = new URL(input);
  } catch {
    throw new SsrfError("Invalid URL");
  }
  for (let hops = 0; hops <= redirects; hops += 1) {
    if (await isPrivateUrl(current, lookupFn)) {
      throw new SsrfError("Blocked: private or unresolvable host");
    }
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new SsrfError("Network error or timeout");
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new SsrfError("Redirect without a Location header");
      }
      try {
        current = new URL(location, current);
      } catch {
        throw new SsrfError("Invalid redirect URL");
      }
      continue;
    }
    return res;
  }
  throw new SsrfError("Too many redirects");
}
