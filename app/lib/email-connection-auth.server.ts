import { FASTMAIL_SESSION_URL, type JmapServer } from "~/lib/jmap.server";
import { connectionAccessToken } from "~/lib/fastmail-oauth.server";
import { decryptSecret } from "~/lib/token-crypto.server";
import { FASTMAIL_AUTHSERV, GMAIL_AUTHSERV } from "~/lib/mime-inbound.server";
import { learnAuthservId } from "~/lib/email-connection-mail.server";
import { setEmailConnectionAuthservId } from "~/lib/db/email-connections";

/**
 * The one place a connection's credential becomes something callable. A
 * connected mailbox is one of three kinds on the wire:
 *
 *  - `gmail`: an OAuth access token for the Gmail API,
 *  - `jmap`: a generic JMAP server the user pointed at, where `tokenEnc`
 *    holds the finished Authorization header (`Bearer …` or `Basic …`) and
 *    there is no refresh (a dead credential surfaces as 401 → the existing
 *    "Needs attention" + reconnect remedy),
 *  - everything else (`fastmail`, legacy pasted tokens): the app's own
 *    FastMail endpoint with an OAuth access token or a plain token.
 *
 * Everything below the session lookup (mailbox ops, push, the drain) takes
 * a `JmapServer`, so the provider branch lives here and nowhere else.
 */

/** The credential fields a connection must expose to be callable. */
export interface ConnectionCredentialSource {
  id: string;
  provider: string;
  /** The generic JMAP endpoint; null for OAuth provider rows. */
  sessionUrl: string | null;
  tokenEnc: string;
  refreshTokenEnc?: string | null;
  tokenExpiresAt?: string | null;
}

/** Adds the fields the delivery-stamp gate needs. */
export interface ConnectionAuthSource extends ConnectionCredentialSource {
  remoteAccountId: string;
  /** The pinned delivery authserv-id, learned at connect (generic JMAP). */
  authservId: string | null;
}

/** A connection's usable credential: the Gmail access token, or the JMAP
 * endpoint and Authorization header. */
export type ConnectionCredential =
  | { kind: "gmail"; token: string }
  | { kind: "jmap"; server: JmapServer };

/** The JMAP endpoint + Authorization header for a connection (never called
 * for Gmail). A generic JMAP row stores the header verbatim; provider rows
 * resolve an access token and speak Bearer to the app's own endpoint. */
export async function connectionJmapServer(
  connection: ConnectionCredentialSource,
): Promise<JmapServer> {
  if (connection.provider === "jmap") {
    if (!connection.sessionUrl) {
      throw new Error("This connection has no server URL; reconnect it.");
    }
    return {
      sessionUrl: connection.sessionUrl,
      authorization: decryptSecret(connection.tokenEnc),
    };
  }
  return {
    sessionUrl: FASTMAIL_SESSION_URL,
    authorization: `Bearer ${await connectionAccessToken(connection)}`,
  };
}

/** One resolver for every consumer: the drain, the cron, the push webhook. */
export async function connectionCredential(
  connection: ConnectionCredentialSource,
): Promise<ConnectionCredential> {
  if (connection.provider === "gmail") {
    return { kind: "gmail", token: await connectionAccessToken(connection) };
  }
  return { kind: "jmap", server: await connectionJmapServer(connection) };
}

/**
 * The authserv-ids whose delivery stamp this connection trusts, for the
 * sender-authentication gate (`evaluateAuthChain`). Fails closed: a generic
 * JMAP connection with no pinned stamp learns it from the mailbox and
 * persists it, and `null` means there is nothing to trust yet, so the
 * caller MUST skip (an empty chain reads as "legacy transport" and would
 * open the gate).
 */
export async function connectionAuthservIds(
  connection: ConnectionAuthSource,
  credential: ConnectionCredential,
): Promise<string[] | null> {
  if (credential.kind === "gmail") return [GMAIL_AUTHSERV];
  if (connection.provider !== "jmap") return [FASTMAIL_AUTHSERV];
  if (connection.authservId) return [connection.authservId];
  const learned = await learnAuthservId(
    credential.server,
    connection.remoteAccountId,
  );
  if (!learned) return null;
  await setEmailConnectionAuthservId(connection.id, learned);
  return [learned];
}
