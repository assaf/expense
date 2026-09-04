import { extractEmailAddress } from "~/lib/validation";

/**
 * INB-SPOOF-1: the From header alone is not proof of origin — anyone can
 * SMTP a message with a verified sender's address in From. The receipts
 * import gate therefore also requires the DELIVERED message to carry a
 * passing authentication result for the From domain, as evaluated by our
 * mail host (Fastmail) and stamped in the newest
 * `Authentication-Results` header it added (authserv-id
 * messagingengine.com).
 *
 * `record` is that header's value, or null/undefined when the message
 * carries no Fastmail-stamped record — the legacy path (transports older
 * than this check): allowed, because Fastmail stamps every delivery and
 * the folder only holds Fastmail-delivered mail.
 *
 * A record passes when ANY of these hold for the From domain:
 *  - `dmarc=pass` (DMARC pass is alignment by definition),
 *  - `dkim=pass` with an aligned `header.d=` domain,
 *  - `spf=pass` with an aligned `smtp.mailfrom=` domain.
 * Alignment = same domain or org-domain suffix in either direction
 * (relaxed DMARC alignment).
 */

export interface AuthVerdict {
  ok: boolean;
  reason: string;
}

interface MethodAuth {
  result?: string;
  domains: string[];
}

interface AuthRecord {
  host: string;
  methods: Record<string, MethodAuth>;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1).toLowerCase();
}

/** Relaxed alignment: equal domains, or one a subdomain of the other. */
function aligns(a: string, b: string): boolean {
  return Boolean(
    a && b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)),
  );
}

/** A-R param keys map to the method whose alignment they qualify. */
function methodKey(paramKey: string): string {
  if (paramKey === "header.d") return "dkim";
  if (paramKey === "smtp.mailfrom") return "spf";
  if (paramKey === "header.from") return "dmarc";
  return paramKey;
}

function parseRecord(record: string): AuthRecord | null {
  const segments = record.split(";");
  const host = (segments[0] ?? "").trim().toLowerCase();
  if (!host) return null;
  const methods: Record<string, MethodAuth> = {};
  for (const segment of segments.slice(1)) {
    for (const token of segment.trim().split(/\s+/)) {
      if (!token || token.startsWith("(")) continue;
      const eq = token.indexOf("=");
      if (eq === -1) continue;
      const key = token.slice(0, eq).toLowerCase();
      const value = token.slice(eq + 1).toLowerCase();
      const method = key.match(/^(dkim|spf|dmarc|auth)$/)?.[1];
      if (method) {
        methods[method] = methods[method] ?? { domains: [] };
        methods[method]!.result = value;
        continue;
      }
      const param = methodKey(key);
      if (param === key) continue; // not an alignment param we use
      const domain = value.replace(/[<>]/g, "").split("@").pop() ?? "";
      if (!domain) continue;
      methods[param] = methods[param] ?? { domains: [] };
      methods[param]!.domains.push(domain);
    }
  }
  return { host, methods };
}

function summary(methods: Record<string, MethodAuth>, method: string): string {
  const entry = methods[method];
  const result = entry?.result ?? "none";
  const domains = (entry?.domains ?? []).join("|") || "no domain";
  return `${method}=${result} (${domains})`;
}

export function evaluateAuthResults(
  record: string | null | undefined,
  fromEmail: string,
): AuthVerdict {
  if (record == null || record === "") {
    return {
      ok: true,
      reason: "no authentication-results record (legacy transport)",
    };
  }
  const parsed = parseRecord(record);
  if (!parsed) {
    return { ok: false, reason: "unparseable authentication-results record" };
  }
  const fromDomain = domainOf(extractEmailAddress(fromEmail) ?? fromEmail);
  if (!fromDomain) {
    return { ok: false, reason: "unparseable From domain" };
  }
  const fail = (): AuthVerdict => ({
    ok: false,
    reason: `${summary(parsed.methods, "dmarc")}, ${summary(parsed.methods, "dkim")}, ${summary(parsed.methods, "spf")} vs From domain ${fromDomain}`,
  });

  // DMARC pass is alignment by definition, but the record names the From
  // domain it evaluated — require it to match anyway (guards against a
  // record evaluated for a different message).
  const dmarc = parsed.methods.dmarc;
  if (dmarc?.result?.startsWith("pass")) {
    if (dmarc.domains.some((domain) => aligns(domain, fromDomain))) {
      return { ok: true, reason: `dmarc=pass aligned with ${fromDomain}` };
    }
  }
  const dkim = parsed.methods.dkim;
  if (dkim?.result?.startsWith("pass")) {
    if (dkim.domains.some((domain) => aligns(domain, fromDomain))) {
      return { ok: true, reason: `dkim=pass aligned with ${fromDomain}` };
    }
  }
  const spf = parsed.methods.spf;
  if (spf?.result?.startsWith("pass")) {
    if (spf.domains.some((domain) => aligns(domain, fromDomain))) {
      return { ok: true, reason: `spf=pass aligned with ${fromDomain}` };
    }
  }
  return fail();
}
