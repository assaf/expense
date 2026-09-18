import { ulid } from "ulid";
import { and } from "@prisma/orm-postgres/orm-client";
import { db } from "~/lib/prisma.server";
import { isUniqueViolation } from "~/lib/db/pg-errors";
import { fromIso, nowWire, toIso, toIsoOrNull } from "~/lib/db/wire";
import type { EmailConnectionRecord } from "~/lib/types";

/**
 * Connected email accounts (Email page → Email accounts): a user's own
 * mailbox linked for automatic expense import. One row per mailbox;
 * emailAddress is globally unique so two workspaces can never race to
 * process (and trash) the same email. API tokens are stored encrypted
 * (token-crypto.server.ts), never in the clear.
 */

/** Row shape the Settings UI and later phases need (never the token). */
export interface EmailConnectionView extends EmailConnectionRecord {
  /** Expenses created from this connection's mail in the last 24h. */
  processedLast24h: number;
  /** Receipts waiting on the review list (/email-review). */
  pendingReview: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The connection columns every caller of this module reads (never the
 * token ciphertext). */
const CONNECTION_FIELDS = [
  "id",
  "accountId",
  "provider",
  "sessionUrl",
  "authservId",
  "emailAddress",
  "status",
  "receivedCount",
  "processedCount",
  "lastPushAt",
  "pushSubscriptionId",
  "pushExpiresAt",
  "reviewScannedAt",
  "createdAt",
] as const;

/** The DB row's shape: the public record's columns pre-timezone-conversion
 * (connectionBase maps wire stamps to ISO), shared by the view and
 * secret-bearing mappers so they can't drift from the record type. */
type ConnectionRow = EmailConnectionRecord;

function connectionBase(row: ConnectionRow) {
  return {
    id: row.id,
    accountId: row.accountId,
    provider: row.provider,
    sessionUrl: row.sessionUrl,
    authservId: row.authservId,
    emailAddress: row.emailAddress,
    status: row.status,
    receivedCount: row.receivedCount,
    processedCount: row.processedCount,
    lastPushAt: toIsoOrNull(row.lastPushAt),
    pushSubscriptionId: row.pushSubscriptionId,
    pushExpiresAt: toIsoOrNull(row.pushExpiresAt),
    reviewScannedAt: toIsoOrNull(row.reviewScannedAt),
    createdAt: toIso(row.createdAt),
  };
}

function toView(
  row: ConnectionRow,
  processedLast24h: number,
  pendingReview: number,
): EmailConnectionView {
  return {
    ...connectionBase(row),
    processedLast24h,
    pendingReview,
  };
}

/** All connections for a workspace, with the processed-last-24h stat. */
export async function listEmailConnections(
  accountId: string,
): Promise<EmailConnectionView[]> {
  const rows = await db.orm.public.EmailConnection.where((c) =>
    c.accountId.eq(accountId),
  )
    .select(...CONNECTION_FIELDS)
    .orderBy((c) => c.createdAt.asc())
    .all();
  if (rows.length === 0) return [];
  const stats = await connectionStats(rows.map((r) => r.id));
  return rows.map((row) => {
    const stat = stats.get(row.id)!;
    return toView(row, stat.processedLast24h, stat.pendingReview);
  });
}

/** Per-connection stats for the Settings list: expenses created in the last
 * 24h, and receipts still waiting on the review list. Ids with no log rows
 * come back as zeros. */
async function connectionStats(
  ids: string[],
): Promise<Map<string, { processedLast24h: number; pendingReview: number }>> {
  const stats = new Map(
    ids.map((id) => [id, { processedLast24h: 0, pendingReview: 0 }]),
  );
  if (ids.length === 0) return stats;
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const [counts, pending] = await Promise.all([
    db.orm.public.EmailProcessLog.where((l) =>
      and(
        l.connectionId.in(ids),
        l.outcome.eq("created"),
        l.createdAt.gte(fromIso(since)),
      ),
    )
      .groupBy("connectionId")
      .aggregate((a) => ({ count: a.count() })),
    db.orm.public.EmailProcessLog.where((l) =>
      and(l.connectionId.in(ids), l.outcome.eq("pending-review")),
    )
      .groupBy("connectionId")
      .aggregate((a) => ({ count: a.count() })),
  ]);
  for (const c of counts) {
    const stat = stats.get(c.connectionId);
    if (stat) stat.processedLast24h = c.count;
  }
  for (const p of pending) {
    const stat = stats.get(p.connectionId);
    if (stat) stat.pendingReview = p.count;
  }
  return stats;
}

export type EmailConnectionProvider = "fastmail" | "gmail" | "jmap";

/**
 * The connection owning a mailbox address, if any. Enforces the global
 * one-workspace-per-mailbox rule at connect time (the DB unique index is
 * the backstop); the id lets a reconnect save over the row in place.
 */
export async function findEmailConnectionByAddress(
  emailAddress: string,
): Promise<{ id: string; accountId: string } | undefined> {
  const row = await db.orm.public.EmailConnection.where((c) =>
    c.emailAddress.eq(emailAddress.trim().toLowerCase()),
  )
    .select("id", "accountId")
    .first();
  return row ?? undefined;
}

/** A connection row with the token ciphertext and push-subscription state
 * (server-side only, never returned to the client). */
export interface EmailConnectionWithSecret extends EmailConnectionRecord {
  tokenEnc: string;
  remoteAccountId: string;
  /** OAuth only; null/absent for legacy API-token connections. */
  refreshTokenEnc?: string | null;
  tokenExpiresAt?: string | null;
}

function rowWithSecret(
  row: ConnectionRow & {
    tokenEnc: string;
    remoteAccountId: string;
    refreshTokenEnc: string | null;
    tokenExpiresAt: string | null;
  },
): EmailConnectionWithSecret {
  return {
    ...connectionBase(row),
    tokenEnc: row.tokenEnc,
    remoteAccountId: row.remoteAccountId,
    refreshTokenEnc: row.refreshTokenEnc,
    tokenExpiresAt: toIsoOrNull(row.tokenExpiresAt),
  };
}

/** A connection with its token, scoped to the owning workspace. */
export async function readEmailConnection(
  accountId: string,
  id: string,
): Promise<EmailConnectionWithSecret | undefined> {
  const row = await db.orm.public.EmailConnection.where((c) =>
    and(c.id.eq(id), c.accountId.eq(accountId)),
  ).first();
  return row ? rowWithSecret(row) : undefined;
}

/** A connection by id alone; the push webhook has no session/account. */
export async function readEmailConnectionById(
  id: string,
): Promise<EmailConnectionWithSecret | undefined> {
  const row = await db.orm.public.EmailConnection.first({ id });
  return row ? rowWithSecret(row) : undefined;
}

/** A connection by mailbox address alone; the Gmail push webhook has no
 * session/account, only the address the push names. */
export async function readEmailConnectionByAddressSecret(
  emailAddress: string,
): Promise<EmailConnectionWithSecret | undefined> {
  const row = await db.orm.public.EmailConnection.where((c) =>
    c.emailAddress.eq(emailAddress.trim().toLowerCase()),
  ).first();
  return row ? rowWithSecret(row) : undefined;
}

/** Every connection across all workspaces, for the renewal cron. */
export async function listAllEmailConnections(): Promise<
  EmailConnectionWithSecret[]
> {
  const rows = await db.orm.public.EmailConnection.orderBy((c) =>
    c.createdAt.asc(),
  ).all();
  return rows.map(rowWithSecret);
}

export type CreateEmailConnectionResult =
  | { ok: true; connection: EmailConnectionView; reconnected: boolean }
  | { ok: false; error: string };

/** The credential set a connect carries, for a new row or a refresh. */
interface ConnectionCredentials {
  accountId: string;
  provider: EmailConnectionProvider;
  emailAddress: string;
  remoteAccountId: string;
  tokenEnc: string;
  refreshTokenEnc?: string;
  tokenExpiresAt?: string;
  /** The generic JMAP session URL (provider "jmap"). */
  sessionUrl?: string;
  /** The delivery authserv-id learned at connect (provider "jmap"). */
  authservId?: string;
}

/**
 * Connect a mailbox, or save fresh credentials over one this workspace
 * already has. The token arrives already verified against the JMAP session
 * endpoint (see jmap.server.ts) and encrypted by the caller; the plaintext
 * never touches the database.
 *
 * Reconnecting saves the newest grant in place: Fastmail revokes the
 * refresh token it handed out before, so the fresh set is the only usable
 * one, and a fresh grant means the connection is healthy again (status
 * back to active). A mailbox another workspace owns is still refused, and
 * one mailbox feeds exactly one workspace.
 */
export async function createEmailConnection(
  input: ConnectionCredentials,
): Promise<CreateEmailConnectionResult> {
  const address = input.emailAddress.trim().toLowerCase();
  const existing = await findEmailConnectionByAddress(address);
  if (existing) {
    if (existing.accountId !== input.accountId) {
      return {
        ok: false,
        error: `${address} is already connected to another workspace.`,
      };
    }
    await saveConnectionCredentials(existing.id, input);
    return {
      ok: true,
      connection: await connectionById(existing.id),
      reconnected: true,
    };
  }
  try {
    const row = await db.orm.public.EmailConnection.create({
      id: ulid(),
      accountId: input.accountId,
      provider: input.provider,
      sessionUrl: input.sessionUrl ?? null,
      authservId: input.authservId ?? null,
      emailAddress: address,
      remoteAccountId: input.remoteAccountId,
      tokenEnc: input.tokenEnc,
      refreshTokenEnc: input.refreshTokenEnc,
      tokenExpiresAt: input.tokenExpiresAt
        ? fromIso(input.tokenExpiresAt)
        : null,
      status: "active",
      createdAt: nowWire(),
    });
    return { ok: true, connection: toView(row, 0, 0), reconnected: false };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // The address check raced another connect; the unique index is the real
    // gate. Refresh in place when the row is ours, refuse when it is not.
    const raced = await findEmailConnectionByAddress(address);
    if (!raced) throw err;
    if (raced.accountId !== input.accountId) {
      return {
        ok: false,
        error: `${address} is already connected to another workspace.`,
      };
    }
    await saveConnectionCredentials(raced.id, input);
    return {
      ok: true,
      connection: await connectionById(raced.id),
      reconnected: true,
    };
  }
}

/** Write the newest credentials over a connection, clearing the OAuth
 * fields when the caller brought none (a pasted API token replaces them),
 * and clearing any needs-attention state. */
async function saveConnectionCredentials(
  id: string,
  input: ConnectionCredentials,
): Promise<void> {
  await db.orm.public.EmailConnection.where({ id }).update({
    provider: input.provider,
    sessionUrl: input.sessionUrl ?? null,
    authservId: input.authservId ?? null,
    remoteAccountId: input.remoteAccountId,
    tokenEnc: input.tokenEnc,
    refreshTokenEnc: input.refreshTokenEnc ?? null,
    tokenExpiresAt: input.tokenExpiresAt ? fromIso(input.tokenExpiresAt) : null,
    status: "active",
  });
}

/** One connection's view with its stats, for a reconnect response. */
async function connectionById(id: string): Promise<EmailConnectionView> {
  const row = await db.orm.public.EmailConnection.where({ id }).first();
  if (!row) throw new Error(`Connection ${id} vanished mid-connect`);
  const stats = await connectionStats([id]);
  const stat = stats.get(id) ?? { processedLast24h: 0, pendingReview: 0 };
  return toView(row, stat.processedLast24h, stat.pendingReview);
}

/**
 * Disconnect a mailbox: delete the row (the token dies with it; revoking
 * the token itself stays a Fastmail-side action for the user). Caller must
 * also destroy the server-side push subscription once phase 2 wires it.
 */
export async function removeEmailConnection(
  accountId: string,
  id: string,
): Promise<boolean> {
  const row = await db.orm.public.EmailConnection.where((c) =>
    and(c.id.eq(id), c.accountId.eq(accountId)),
  )
    .select("id")
    .first();
  if (!row) return false;
  await db.orm.public.EmailConnection.where({ id }).delete();
  return true;
}

/** Record the subscription the renewal created (or found) for a connection. */
export async function saveEmailConnectionSubscription(
  id: string,
  subscriptionId: string,
  expiresAt: string,
): Promise<void> {
  await db.orm.public.EmailConnection.where({ id }).update({
    pushSubscriptionId: subscriptionId,
    pushExpiresAt: fromIso(expiresAt),
  });
}

/** Record the delivery authserv-id learned for a generic JMAP connection
 * (see connectionAuthservIds), so the sender-authentication gate is pinned
 * from then on. */
export async function setEmailConnectionAuthservId(
  id: string,
  authservId: string,
): Promise<void> {
  await db.orm.public.EmailConnection.where({ id }).update({ authservId });
}

/** Record a Gmail watch expiration: Gmail has no subscription id, only an
 * expiration the daily cron renews at a 48h margin. */
export async function saveEmailConnectionWatch(
  id: string,
  expiresAt: string,
): Promise<void> {
  await db.orm.public.EmailConnection.where({ id }).update({
    pushExpiresAt: fromIso(expiresAt),
  });
}

/** A push arrived: stamp lastPushAt (the "last handled webhook" stat). */
export async function touchEmailConnectionPush(id: string): Promise<void> {
  await db.orm.public.EmailConnection.where({ id }).update({
    lastPushAt: nowWire(),
  });
}

/** Set/clear the needs-attention state shown on the Email page. */
export async function setEmailConnectionStatus(
  id: string,
  status: "active" | "error",
): Promise<void> {
  await db.orm.public.EmailConnection.where({ id }).update({ status });
}

/**
 * Persist rotated OAuth credentials. The refresh token rotates on every
 * exchange (Fastmail revokes the old one), so whatever the token endpoint
 * returns must be saved before the next call; null clears a field.
 */
export async function updateEmailConnectionTokens(input: {
  id: string;
  tokenEnc: string;
  refreshTokenEnc?: string | null;
  tokenExpiresAt?: string | null;
}): Promise<void> {
  await db.orm.public.EmailConnection.where({ id: input.id }).update({
    tokenEnc: input.tokenEnc,
    refreshTokenEnc: input.refreshTokenEnc ?? null,
    tokenExpiresAt: input.tokenExpiresAt ? fromIso(input.tokenExpiresAt) : null,
  });
}
