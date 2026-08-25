/**
 * One-shot cross-page trigger bus for the Cmd+K palette.
 *
 * The palette mounts at the root layout, but the UI it triggers (the home
 * page's file picker and search box, the reconcile landing's statement file
 * picker) lives in page components that mount only after navigation. This
 * bus carries those requests across the navigate-then-mount boundary:
 *
 * - `requestCommand` stores the request as pending AND fires every current
 *   listener synchronously, so an already-mounted target page handles it in
 *   the same tick.
 * - A consumer consumes a request only when it handles that kind. A request
 *   that reaches a page which doesn't handle it (the palette always
 *   navigates, but any page can be mounted when the command fires) stays
 *   pending for the page that does handle it.
 * - Pending requests expire after `REQUEST_TTL_MS`, so a request whose
 *   target page never mounted can't pop a file picker much later.
 *
 * Exactly one route is mounted at a time and consumers consume what they
 * handle, so a request is never handled twice or by two pages.
 */

export type CommandRequest =
  | { kind: "upload-expense" }
  | { kind: "upload-reconcile" }
  | { kind: "search-expenses"; query: string };

type Listener = (request: CommandRequest) => void;

/** Requests older than this are dropped instead of handled: a file picker
 * popping seconds after the command was issued reads as a bug. Generous
 * enough for a slow client-side navigation to complete. */
const REQUEST_TTL_MS = 5000;

let pending: { request: CommandRequest; at: number } | null = null;
const listeners = new Set<Listener>();

/** Store the request as pending and fire every current listener synchronously. */
export function requestCommand(request: CommandRequest): void {
  pending = { request, at: Date.now() };
  for (const listener of listeners) listener(request);
}

/**
 * Clear the pending request and return it. Call only when the kind is one
 * this consumer handles. Returns null when nothing is pending or the only
 * pending request has expired.
 */
export function consumeCommandRequest(): CommandRequest | null {
  const entry = pending;
  pending = null;
  if (!entry || Date.now() - entry.at > REQUEST_TTL_MS) return null;
  return entry.request;
}

/** Subscribe to requests. Returns an unsubscribe function. */
export function onCommandRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
