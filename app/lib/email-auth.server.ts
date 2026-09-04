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
 * A record may carry MULTIPLE clauses per method (e.g. two DKIM
 * signatures: a bogus one claiming the From domain that fails, plus a
 * valid attacker-domain one that passes). Evaluation is STRICTLY
 * per-clause: a clause passes only when ITS OWN result is a pass AND one
 * of ITS OWN identity domains aligns with the From domain. Cross-pairing
 * a result from one clause with a domain from another is the exact
 * bypass this structure exists to prevent.
 *
 * A record passes when ANY clause satisfies that rule for:
 *  - `dmarc` (DMARC pass is alignment by definition, but its
 *    `header.from=` domain must still align),
 *  - `dkim` (its `header.d=` domains),
 *  - `spf` (its `smtp.mailfrom=` domain).
 * Alignment = same domain or org-domain suffix in either direction
 * (relaxed DMARC alignment).
 *
 * The forward path (INB-FWD-1) lives in the pipeline, not here: a
 * client-side forward keeps the ORIGINAL sender in From, so no passing
 * clause aligns with it. The pipeline instead matches the record's passing
 * domains (passingAuthDomains) against verified receipts-by-email senders
 * (findVerifiedForwarder): a pass aligned with a verified sender's domain
 * proves the message entered through that sender's authenticated mail,
 * the same owner-proof a From-aligned pass carries, since spoofing it
 * requires sending AS that domain.
 */

export interface AuthVerdict {
  ok: boolean;
  reason: string;
}

interface AuthClause {
  method: string;
  result: string;
  domains: string[];
}

interface AuthRecord {
  host: string;
  clauses: AuthClause[];
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1).toLowerCase();
}

/** Relaxed alignment: equal domains, or one a subdomain of the other.
 * Shared with the forwarder lookup in the inbound pipeline. */
export function aligns(a: string, b: string): boolean {
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
  const clauses: AuthClause[] = [];
  let current: AuthClause | null = null;
  for (const segment of segments.slice(1)) {
    for (const token of segment.trim().split(/\s+/)) {
      if (!token || token.startsWith("(")) continue;
      const eq = token.indexOf("=");
      if (eq === -1) continue;
      const key = token.slice(0, eq).toLowerCase();
      const value = token.slice(eq + 1).toLowerCase();
      const method = key.match(/^(dkim|spf|dmarc|auth)$/)?.[1];
      if (method) {
        current = { method, result: value, domains: [] };
        clauses.push(current);
        continue;
      }
      const param = methodKey(key);
      // Params before the first method clause (or params we don't use)
      // carry no verdict weight.
      if (!current || param === key) continue;
      const domain = value.replace(/[<>]/g, "").split("@").pop() ?? "";
      if (domain) current.domains.push(domain);
    }
  }
  return { host, clauses };
}

function summarize(clauses: AuthClause[]): string {
  if (clauses.length === 0) return "no authentication clauses";
  return clauses
    .map(
      (c) => `${c.method}=${c.result} (${c.domains.join("|") || "no domain"})`,
    )
    .join(", ");
}

/** Union of the domains the chain's clause-bearing records authenticate
 * (dkim `header.d=`, spf `smtp.mailfrom=`, dmarc `header.from=`), deduped.
 * Empty stamps (account-internal deliveries) contribute nothing. Used to
 * match a passing clause against verified forwarder domains (INB-FWD-1). */
export function passingAuthDomains(
  records: string | string[] | null | undefined,
): string[] {
  const chain = Array.isArray(records) ? records : [records];
  const domains = new Set<string>();
  for (const record of chain) {
    if (record == null || record === "") continue;
    const parsed = parseRecord(record);
    if (!parsed) continue;
    for (const clause of parsed.clauses) {
      if (clause.method === "auth") continue; // auth-service result, no identity
      if (!clause.result.startsWith("pass")) continue;
      for (const domain of clause.domains) domains.add(domain);
    }
  }
  return [...domains];
}

/**
 * Evaluate the message's Authentication-Results chain, newest stamp first
 * (see authResultsChain). Empty stamps — the host stamped the delivery but
 * evaluated nothing, which only happens for account-internal hops (a
 * same-account submission or an internal redirect) — carry no verdict and
 * are skipped. When every record is empty, the message never crossed an
 * external hop: only an authenticated submission into the account (or the
 * account's own redirect of such mail) can produce that, so it passes as
 * owner-internal mail. An attacker's mail always enters from outside and
 * therefore always has a clause-bearing stamp, which is then held to the
 * strict From-aligned rule below.
 */
export function evaluateAuthChain(
  records: string[],
  fromEmail: string,
): AuthVerdict {
  if (records.length === 0) {
    return {
      ok: true,
      reason: "no authentication-results record (legacy transport)",
    };
  }
  let sawClauses = false;
  let lastReason = "no authentication clauses";
  for (const record of records) {
    if (record == null || record === "") continue;
    const parsed = parseRecord(record);
    if (!parsed || parsed.clauses.length === 0) continue;
    sawClauses = true;
    const verdict = evaluateAuthResults(record, fromEmail);
    if (verdict.ok) return verdict;
    lastReason = verdict.reason;
  }
  if (!sawClauses) {
    return {
      ok: true,
      reason: "no external hop: delivered inside the mail host's account",
    };
  }
  return { ok: false, reason: lastReason };
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
  for (const clause of parsed.clauses) {
    if (clause.method === "auth") continue; // auth-service result, no identity
    if (
      clause.result.startsWith("pass") &&
      clause.domains.some((domain) => aligns(domain, fromDomain))
    ) {
      return {
        ok: true,
        reason: `${clause.method}=pass aligned with ${fromDomain}`,
      };
    }
  }
  return {
    ok: false,
    reason: `${summarize(parsed.clauses)} vs From domain ${fromDomain}`,
  };
}
