import { ulid } from "ulid";
import prisma from "~/lib/prisma.server";
import type { EmailConnectionRecord } from "~/lib/types";

/**
 * Connected email accounts (Email page → Email accounts): a user's own
 * mailbox linked for automatic expense import. One row per mailbox —
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

function toView(
  row: {
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
  },
  processedLast24h: number,
  pendingReview: number,
): EmailConnectionView {
  return {
    id: row.id,
    accountId: row.accountId,
    provider: row.provider,
    emailAddress: row.emailAddress,
    status: row.status,
    receivedCount: row.receivedCount,
    processedCount: row.processedCount,
    lastPushAt: row.lastPushAt,
    pushSubscriptionId: row.pushSubscriptionId,
    pushExpiresAt: row.pushExpiresAt,
    reviewScannedAt: row.reviewScannedAt,
    createdAt: row.createdAt,
    processedLast24h,
    pendingReview,
  };
}

const CONNECTION_SELECT = {
  id: true,
  accountId: true,
  provider: true,
  emailAddress: true,
  status: true,
  receivedCount: true,
  processedCount: true,
  lastPushAt: true,
  pushSubscriptionId: true,
  pushExpiresAt: true,
  reviewScannedAt: true,
  createdAt: true,
} as const;

/** All connections for a workspace, with the processed-last-24h stat. */
export async function listEmailConnections(
  accountId: string,
): Promise<EmailConnectionView[]> {
  const rows = await prisma.emailConnection.findMany({
    where: { accountId },
    select: CONNECTION_SELECT,
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) return [];
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const [counts, pending] = await Promise.all([
    prisma.emailProcessLog.groupBy({
      by: ["connectionId"],
      where: {
        connectionId: { in: rows.map((r) => r.id) },
        outcome: "created",
        createdAt: { gte: since },
      },
      _count: { _all: true },
    }),
    prisma.emailProcessLog.groupBy({
      by: ["connectionId"],
      where: {
        connectionId: { in: rows.map((r) => r.id) },
        outcome: "pending-review",
      },
      _count: { _all: true },
    }),
  ]);
  const byConnection = new Map(
    counts.map((c) => [c.connectionId, c._count._all]),
  );
  const byConnectionPending = new Map(
    pending.map((c) => [c.connectionId, c._count._all]),
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
  const row = await prisma.emailConnection.findUnique({
    where: { emailAddress: emailAddress.trim().toLowerCase() },
    select: { accountId: true },
  });
  return row ?? undefined;
}

/** A connection row with the token ciphertext and push-subscription state
 * (server-side only — never returned to the client). */
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
    id: row.id,
    accountId: row.accountId,
    provider: row.provider,
    emailAddress: row.emailAddress,
    status: row.status,
    receivedCount: row.receivedCount,
    processedCount: row.processedCount,
    lastPushAt: row.lastPushAt,
    pushSubscriptionId: row.pushSubscriptionId,
    pushExpiresAt: row.pushExpiresAt,
    reviewScannedAt: row.reviewScannedAt,
    createdAt: row.createdAt,
    tokenEnc: row.tokenEnc,
    jmapAccountId: row.jmapAccountId,
  };
}

/** A connection with its token, scoped to the owning workspace. */
export async function readEmailConnection(
  accountId: string,
  id: string,
): Promise<EmailConnectionWithSecret | undefined> {
  const row = await prisma.emailConnection.findFirst({
    where: { id, accountId },
  });
  return row ? rowWithSecret(row) : undefined;
}

/** A connection by id alone — the push webhook has no session/account. */
export async function readEmailConnectionById(
  id: string,
): Promise<EmailConnectionWithSecret | undefined> {
  const row = await prisma.emailConnection.findUnique({ where: { id } });
  return row ? rowWithSecret(row) : undefined;
}

/** Every connection across all workspaces, for the renewal cron. */
export async function listAllEmailConnections(): Promise<
  EmailConnectionWithSecret[]
> {
  const rows = await prisma.emailConnection.findMany({
    orderBy: { createdAt: "asc" },
  });
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
  const row = await prisma.emailConnection.create({
    data: {
      id: ulid(),
      accountId: input.accountId,
      provider: input.provider,
      emailAddress: address,
      jmapAccountId: input.jmapAccountId,
      tokenEnc: input.tokenEnc,
      status: "active",
      createdAt: new Date().toISOString(),
    },
    select: CONNECTION_SELECT,
  });
  return { ok: true, connection: toView(row, 0, 0) };
}

/**
 * Disconnect a mailbox: delete the row (the token dies with it — revoking
 * the token itself stays a FastMail-side action for the user). Caller must
 * also destroy the server-side push subscription once phase 2 wires it.
 */
export async function removeEmailConnection(
  accountId: string,
  id: string,
): Promise<boolean> {
  const row = await prisma.emailConnection.findFirst({
    where: { id, accountId },
    select: { id: true },
  });
  if (!row) return false;
  await prisma.emailConnection.delete({ where: { id } });
  return true;
}

/** Record the subscription the renewal created (or found) for a connection. */
export async function saveEmailConnectionSubscription(
  id: string,
  subscriptionId: string,
  expiresAt: string,
): Promise<void> {
  await prisma.emailConnection.update({
    where: { id },
    data: { pushSubscriptionId: subscriptionId, pushExpiresAt: expiresAt },
  });
}

/** A push arrived — stamp lastPushAt (the "last handled webhook" stat). */
export async function touchEmailConnectionPush(id: string): Promise<void> {
  await prisma.emailConnection.update({
    where: { id },
    data: { lastPushAt: new Date().toISOString() },
  });
}

/** Set/clear the needs-attention state shown on the Email page. */
export async function setEmailConnectionStatus(
  id: string,
  status: "active" | "error",
): Promise<void> {
  await prisma.emailConnection.update({ where: { id }, data: { status } });
}
