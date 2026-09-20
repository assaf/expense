import { decryptSecret, encryptSecret } from "~/lib/token-crypto.server";
import {
  readEmailConnectionById,
  updateEmailConnectionTokens,
} from "~/lib/db/email-connections";

/**
 * The token plumbing the Fastmail and Google OAuth modules share: the POST
 * both token endpoints answer, and the credential resolver each connection
 * goes through before a mail call. Everything provider-specific stays in
 * those modules (scopes, client credentials, the flow structs, and how each
 * endpoint's expiry lands in its own token set).
 */

/**
 * The provider refused the stored grant. That is the user's to fix (they
 * re-authorize the mailbox), unlike a timeout, a 5xx or a 401 on the token
 * endpoint, and callers use the distinction to flag the connection and tell
 * the account. A `client_id` mismatch comes back as `invalid_grant` too and
 * reconnecting does fix it (the fresh grant is issued to the current
 * client), so it stays in this class.
 */
export class OAuthRefreshError extends Error {}

/** Token endpoints answer quickly; a hung one must not pin a request. */
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

/** Refresh this long before expiry so concurrent calls never race a dying
 * token (both providers issue ~1h access tokens). */
const REFRESH_SKEW_MS = 60_000;

/** The response fields both endpoints have in common, validated. The two
 * optional ones are null when the response omits them: Google leaves out
 * refresh_token on a refresh, and only Google sends an id_token. Each
 * module maps this onto its own token set, which fixes the expiry units. */
interface TokenEndpointResponse {
  accessToken: string;
  refreshToken: string | null;
  /** Lifetime in seconds, as the wire's expires_in. */
  expiresIn: number;
  idToken: string | null;
}

/**
 * POST an x-www-form-urlencoded body to a provider's token endpoint and
 * validate the answer down to the shape both providers agree on.
 * `providerLabel` ("Fastmail" / "Google") names the provider in the errors
 * the callers surface.
 */
export async function requestTokenSet(
  url: string,
  form: Record<string, string>,
  providerLabel: string,
): Promise<TokenEndpointResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    const message = `${providerLabel} token endpoint returned HTTP ${res.status}: ${text.slice(0, 200)}`;
    // A rejected grant is the one failure the user can act on; the rest are
    // transient or app-side and must not flag a connection or email anyone.
    if (res.status === 400 && /invalid_grant/.test(text)) {
      throw new OAuthRefreshError(message);
    }
    throw new Error(message);
  }
  const body = JSON.parse(text) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    id_token?: unknown;
  };
  if (
    typeof body.access_token !== "string" ||
    typeof body.expires_in !== "number"
  ) {
    throw new Error(
      `${providerLabel} token endpoint returned an unexpected shape`,
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresIn: body.expires_in,
    idToken: typeof body.id_token === "string" ? body.id_token : null,
  };
}

/** The stored credential fields the resolver touches: the encrypted access
 * token, its ISO expiry, and the encrypted refresh token.
 * `ConnectionCredentials` (fastmail-oauth.server.ts) and
 * `EmailConnectionWithSecret` both satisfy this structurally. */
interface TokenConnection {
  id: string;
  tokenEnc: string;
  /** OAuth only; null/absent for legacy API-token connections. */
  refreshTokenEnc?: string | null;
  tokenExpiresAt?: string | null;
}

/** What the resolver itself needs out of a refreshed set; a provider's own
 * token set carries more (its refresh token, an id_token). */
interface RefreshedTokens {
  accessToken: string;
  /** ISO timestamp when the new access token dies. */
  expiresAt: string;
}

// Concurrent calls share one connection and can each hit expiry; dedup
// them on a single refresh per connection (same pattern as
// jmapSessionForToken), evicting on settle so a failure retries.
const inflightRefreshes = new Map<string, Promise<string>>();

/**
 * The credential resolver both providers delegate to: legacy API-token
 * rows decrypt straight through (behavior identical to the pre-OAuth code);
 * OAuth rows return the cached access token until 60s before expiry, then
 * refresh and persist the rotated credentials. Throws on refresh failure
 * (callers' catch blocks flag the row error).
 *
 * `refresh` exchanges the stored refresh token (already decrypted) at the
 * provider's token endpoint. `persistRefreshToken` says which refresh token
 * to store afterwards, in the clear, because the providers disagree:
 * Fastmail rotates on every grant, Google keeps the stored one when the
 * response omits it (persisting null would clear it).
 */
export async function resolveConnectionAccessToken<T extends RefreshedTokens>({
  connection,
  refresh,
  persistRefreshToken,
}: {
  connection: TokenConnection;
  refresh: (refreshToken: string) => Promise<T>;
  persistRefreshToken: (refreshed: T, storedRefreshToken: string) => string;
}): Promise<string> {
  if (!connection.refreshTokenEnc) {
    return decryptSecret(connection.tokenEnc);
  }
  const expiresAt = connection.tokenExpiresAt
    ? Date.parse(connection.tokenExpiresAt)
    : 0;
  if (expiresAt - REFRESH_SKEW_MS > Date.now()) {
    return decryptSecret(connection.tokenEnc);
  }
  let pending = inflightRefreshes.get(connection.id);
  if (!pending) {
    pending = refreshRotated({
      connection,
      refresh,
      persistRefreshToken,
    }).then(
      (token) => {
        inflightRefreshes.delete(connection.id);
        return token;
      },
      (err) => {
        inflightRefreshes.delete(connection.id);
        throw err;
      },
    );
    inflightRefreshes.set(connection.id, pending);
  }
  return pending;
}

/**
 * One exchange, against the row as it stands now rather than against the
 * caller's copy of it. A cron tick resolves the same connection twice (the
 * push-subscription renewal, then the catch-up drain) from one row it read
 * at the top of the tick, so by the time the second resolution asks, the
 * first has already rotated the pair: Fastmail revokes a refresh token the
 * moment it hands out the next one, and replaying the caller's copy fails
 * as invalid_grant on a connection that is perfectly healthy. The same
 * staleness reaches across lambdas, which the in-process `inflightRefreshes`
 * map above cannot cover. So read the row again here, and spend an exchange
 * only if its access token is still expired.
 */
async function refreshRotated<T extends RefreshedTokens>({
  connection,
  refresh,
  persistRefreshToken,
}: {
  connection: TokenConnection;
  refresh: (refreshToken: string) => Promise<T>;
  persistRefreshToken: (refreshed: T, storedRefreshToken: string) => string;
}): Promise<string> {
  const current = await readEmailConnectionById(connection.id);
  const row = current ?? connection;
  const expiresAt = row.tokenExpiresAt ? Date.parse(row.tokenExpiresAt) : 0;
  if (expiresAt - REFRESH_SKEW_MS > Date.now()) {
    return decryptSecret(row.tokenEnc);
  }
  if (!row.refreshTokenEnc) {
    return decryptSecret(row.tokenEnc);
  }
  const storedRefreshToken = decryptSecret(row.refreshTokenEnc);
  let refreshed: T;
  try {
    refreshed = await refresh(storedRefreshToken);
  } catch (err) {
    // Another instance may have rotated the pair while this exchange was in
    // flight: the in-process dedupe above cannot cover a second lambda, and
    // the provider ratchets, so replaying a spent refresh token fails on a
    // connection that is perfectly healthy. A row that now carries a usable
    // access token IS that case, so take it — failing here would flag a
    // working mailbox and tell its owner to reconnect for nothing.
    const recheck = await readEmailConnectionById(connection.id);
    const rotatedAt = recheck?.tokenExpiresAt
      ? Date.parse(recheck.tokenExpiresAt)
      : 0;
    if (recheck && rotatedAt - REFRESH_SKEW_MS > Date.now()) {
      console.info("[oauth] refresh lost a race to another instance", {
        connectionId: connection.id,
      });
      return decryptSecret(recheck.tokenEnc);
    }
    throw err;
  }
  await updateEmailConnectionTokens({
    id: connection.id,
    tokenEnc: encryptSecret(refreshed.accessToken),
    refreshTokenEnc: encryptSecret(
      persistRefreshToken(refreshed, storedRefreshToken),
    ),
    tokenExpiresAt: refreshed.expiresAt,
  });
  return refreshed.accessToken;
}
