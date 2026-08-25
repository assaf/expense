import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard + guarded fetch for server-side requests to URLs that may be
 * supplied by an untrusted party (the MCP `capture_receipt` url argument,
 * `<img src>` URLs inside forwarded email HTML).
 *
 * `fetchPublicUrl` only follows http(s), rejects private/unresolvable hosts
 * (literal address AND DNS-resolved: a public-looking hostname that
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
 * literal IPs return false here; `isPrivateUrl` resolves those and checks
 * every resulting address. IPv6 literals are fully parsed (not regex
 * matched), so every spelling of a private range is caught: `::ffff:a00:1`
 * is IPv4-mapped 10.0.0.1 and must be blocked the same as the dotted form. */
export function isPrivateHost(hostname: string): boolean {
  let h = hostname.toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1); // "[::1]"
  if (h === "localhost" || h === "localhost.localdomain") return true;
  if (isIP(h) === 4) {
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return true; // fail closed: unparseable literal
    return isPrivateIpv4(
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      Number(m[4]),
    );
  }
  if (isIP(h) === 6) {
    return isPrivateIpv6(h);
  }
  // Not an IP literal; hostnames are checked by resolving every A/AAAA
  // record in isPrivateUrl. (A plain name can never be "private" itself;
  // this also stops the old fc/fd prefix check from blocking legitimate
  // hosts like fcc.gov.)
  return false;
}

function isPrivateIpv4(a: number, b: number, _c: number, _d: number): boolean {
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

/** Parse an IPv6 literal into its 8 groups of 16 bits (handles `::`
 * compression and a dotted-decimal IPv4 tail). null when unparseable;
 * callers fail closed. */
function ipv6Groups(addr: string): number[] | null {
  let s = addr.toLowerCase();
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const lastPart = s.slice(lastColon + 1);
  if (lastPart.includes(".")) {
    const m = lastPart.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return null;
    tail = [
      (Number(m[1]) << 8) | Number(m[2]),
      (Number(m[3]) << 8) | Number(m[4]),
    ];
    s = s.slice(0, lastColon); // drop the trailing ":" too
  }
  const parts = s.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tailHex = parts[1] ? parts[1].split(":") : [];
  const headGroups = head.map((g) => (g ? parseInt(g, 16) : NaN));
  const tailGroups = tailHex.map((g) => (g ? parseInt(g, 16) : NaN));
  if (headGroups.some(Number.isNaN) || tailGroups.some(Number.isNaN)) {
    return null;
  }
  if (parts.length === 1) {
    const all = [...headGroups, ...tailGroups, ...tail];
    return all.length === 8 ? all : null;
  }
  const zeros = 8 - headGroups.length - tailGroups.length - tail.length;
  if (zeros < 0) return null;
  return [
    ...headGroups,
    ...Array.from<number>({ length: zeros }).fill(0),
    ...tailGroups,
    ...tail,
  ];
}

/** Private/reserved IPv6 ranges, on the canonical 8-group form:
 * unspecified (::), loopback (::1), IPv4-mapped (::ffff:a.b.c.d, where the
 * embedded address is checked with the IPv4 rules), link-local (fe80::/10),
 * unique-local (fc00::/7), site-local (fec0::/10), and multicast (ff00::/8).
 * Anything unparseable is treated as private (fail closed). */
function isPrivateIpv6(h: string): boolean {
  const g = ipv6Groups(h);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (
    g[0] === 0 &&
    g[1] === 0 &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0 &&
    g[6] === 0 &&
    g[7] === 1
  ) {
    return true; // ::1
  }
  if (
    g[0] === 0 &&
    g[1] === 0 &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0xffff
  ) {
    // IPv4-mapped (dotted or hex form): check the embedded IPv4.
    return isPrivateIpv4(g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff);
  }
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique-local (fc/fd)
  if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/**
 * True when a URL would reach a private or unresolvable address: the
 * literal host is checked first, then the hostname is resolved and every
 * A/AAAA record is checked (a rebinding-friendly hostname with any private
 * record is rejected). Fails closed; unresolvable hostnames are private.
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
 * failed request. The response is NOT size-limited here; callers bound the
 * body per use case with `readBodyLimited`. */
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
    // Note: built-in fetch re-resolves the hostname, so a hostile DNS could
    // in theory answer public here and private during the fetch (rebinding
    // TOCTOU). Every record is checked up front and IP literals have no DNS
    // at all; fully closing the window would require pinning the connection
    // to the checked address with a custom TLS agent. On Vercel, function
    // egress cannot reach private ranges anyway, so this guard is
    // defense-in-depth for self-hosted instances.
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

/**
 * Read a fetch response body into memory, aborting once `maxBytes` is
 * exceeded. A server-side fetch of a user-supplied URL must never buffer an
 * unbounded stream: the size check has to happen DURING the read, not
 * after `arrayBuffer()` has already committed the memory. Throws SsrfError
 * when the body is larger; the underlying stream is cancelled so the
 * download stops.
 */
export async function readBodyLimited(
  res: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new SsrfError(`Response too large (over ${maxBytes} bytes)`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
