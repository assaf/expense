import { ulid } from "ulid";
import { and } from "@prisma/orm-postgres/orm-client";
import { db } from "~/lib/prisma.server";
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

/** The columns every connection read maps, shared by the view and
 * secret-bearing mappers so the two can't drift apart. */
interface ConnectionRow {
  id: string;
  accountId: string;
  provider: string;
  emailAddress: string;
  status: string;
  receivedCount: number;
  processedCount: number;
  lastPushAt: string | null;
  pushSubscriptionId: string | null;
  pushExpiresAt: string | null;
  reviewScannedAt: string | null;
  createdAt: string;
}

function connectionBase(row: ConnectionRow) {
  return {
    id: row.id,
    accountId: row.accountId,
    provider: row.provider,
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
  const ids = rows.map((r) => r.id);
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
  const byConnection = new Map(counts.map((c) => [c.connectionId, c.count]));
  const byConnectionPending = new Map(
    pending.map((c) => [c.connectionId, c.count]),
  );
  return rows.map((row) =>
    toView(
      row,
      byConnection.get(row.id) ?? 0,
      byConnectionPending.get(row.id) ?? 0,
    ),
  );
}

/**
 * The connection owning a mailbox address, if any. Enforces the global
 * one-workspace-per-mailbox rule at connect time (the DB unique index is
 * the backstop).
 */
export async function findEmailConnectionByAddress(
  emailAddress: string,
): Promise<{ accountId: string } | undefined> {
  const row = await db.orm.public.EmailConnection.where((c) =>
    c.emailAddress.eq(emailAddress.trim().toLowerCase()),
  )
    .select("accountId")
    .first();
  return row ?? undefined;
}

/** A connection row with the token ciphertext and push-subscription state
 * (server-side only, never returned to the client). */
export interface EmailConnectionWithSecret extends EmailConnectionRecord {
  tokenEnc: string;
  jmapAccountId: string;
}

function rowWithSecret(row: {
  id: string;
  accountId: string;
  provider: string;
  emailAddress: string;
  status: string;
  receivedCount: number;
  processedCount: number;
  lastPushAt: string | null;
  pushSubscriptionId: string | null;
  pushExpiresAt: string | null;
  reviewScannedAt: string | null;
  createdAt: string;
  tokenEnc: string;
  jmapAccountId: string;
}): EmailConnectionWithSecret {
  return {
    ...connectionBase(row),
    tokenEnc: row.tokenEnc,
    jmapAccountId: row.jmapAccountId,
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
  | { ok: true; connection: EmailConnectionView }
  | { ok: false; error: string };

/**
 * Save a verified connection. The token arrives already verified against
 * the JMAP session endpoint (see jmap.server.ts); it is encrypted here and
 * the plaintext never touches the database.
 */
export async function createEmailConnection(input: {
  accountId: string;
  provider: string;
  emailAddress: string;
  jmapAccountId: string;
  tokenEnc: string;
}): Promise<CreateEmailConnectionResult> {
  const address = input.emailAddress.trim().toLowerCase();
  const existing = await findEmailConnectionByAddress(address);
  if (existing) {
    return {
      ok: false,
      error:
        existing.accountId === input.accountId
          ? `${address} is already connected.`
          : `${address} is already connected to another workspace.`,
    };
  }
  const row = await db.orm.public.EmailConnection.create({
    id: ulid(),
    accountId: input.accountId,
    provider: input.provider,
    emailAddress: address,
    jmapAccountId: input.jmapAccountId,
    tokenEnc: input.tokenEnc,
    status: "active",
    createdAt: nowWire(),
  });
  return {
    ok: true,
    connection: toView(row, 0, 0),
  };
}

/**
 * Disconnect a mailbox: delete the row (the token dies with it; revoking
 * the token itself stays a FastMail-side action for the user). Caller must
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
