/**
 * Error values made safe to print: the credential redaction every provider
 * message goes through, and the cause-chain walk every recognizer shares.
 *
 * Deliberately dependency-free (like `~/lib/upload-limits`) so `jmap.server.ts`
 * can import it: that module must stay free of `env.ts` and of anything that
 * pulls in `@sentry/react-router`, or it drags the SDK and the test network
 * guard into every JMAP call.
 */

// --- Credential redaction ----------------------------------------------------

/** An auth scheme with its value. */
const AUTH_SCHEME_RUN = /\b(?:bearer|basic)\s+\S+/gi;
// Three things this has to get right, each of them a bug the adversarial
// pass found in the first version:
//  - the prefix run (`refresh_token=`, `x-api-key=`) is what `\b` cannot do,
//    since it never fires after `_`. It is BOUNDED at 6 segments: unbounded,
//    the run backtracks quadratically on ordinary `a_a_a_…` text (30s+ at
//    64k characters);
//  - the lookbehind keeps the match zero-width, so replacing it does not eat
//    the space or comma in front of the secret;
//  - `["']?` and the quoted-value alternative cover a JSON body
//    (`{"client_secret":"…"}`), which is the shape a provider error quotes.
//    The trailing `key|value|hash|id` covers `secret_key=` / `token_value=`.
const ASSIGNED_SECRET =
  /(?<![a-z0-9])(?:[a-z0-9]+[_-]){0,6}(?:token|secret|password|api[-_]?key)(?:_?(?:key|value|hash|id))?["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi;
const JWT_RUN = /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

const REDACTED = "[redacted]";

/**
 * Replace anything credential-shaped in text that is about to be logged,
 * mailed, or put in an error message.
 *
 * The `access_token=` query parameter matters most: a Fastmail session
 * document hands every endpoint its credential in the URL
 * (`apiUrl: …/jmap/api/?access_token=…`), and a provider that echoes the
 * token it looked up would otherwise print it to stdout and into Sentry.
 * Run this on provider response text BEFORE it becomes part of a message;
 * masking an error after the fact cannot un-print the console line.
 */
export function redactCredentials(text: string): string {
  return text
    .replace(AUTH_SCHEME_RUN, REDACTED)
    .replace(ASSIGNED_SECRET, REDACTED)
    .replace(JWT_RUN, REDACTED);
}

// --- Cause chains -----------------------------------------------------------

/**
 * Whether `type` appears in `error` or anywhere along its `cause` chain.
 *
 * The walk, not a bare `instanceof`: re-labelling a failure with a new Error
 * that keeps the original as `cause` is how the drain names each step, and a
 * recognizer that stops at the wrapper never sees the class it is looking
 * for. Bounded at 8 links and `Error`-only, so a self-referential or
 * `any`-shaped chain cannot spin.
 */
export function causesInclude<T extends Error>(
  error: unknown,
  type: new (...args: never[]) => T,
): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current instanceof type) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// --- Grouping stability -----------------------------------------------------

// Per-occurrence identifiers a provider stamps on every response. Left in a
// message they would split one failure mode into one issue per request,
// which is exactly the re-opening the drain's warn-on-transition-only guard
// exists to prevent.
const VOLATILE_ID =
  /\b(?:ti_[0-9a-f]{8,}|\b[0-9a-f]{16,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)/gi;

/**
 * Collapse per-occurrence identifiers so the same failure keeps the same
 * text — and therefore the same Sentry issue — every time it happens.
 * Everything else is left alone: a status code, a provider error code and a
 * trace of the failing step are what make the line worth reading.
 */
export function stableForGrouping(text: string): string {
  return text.replace(VOLATILE_ID, "<id>");
}
