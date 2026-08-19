import { ulid } from "ulid";
import prisma from "~/lib/prisma.server";
import type { EmailConnectionRecord } from "~/lib/types";

/**
 * Connected email accounts (Settings → Email accounts): a user's own
 * mailbox linked for automatic expense import. One row per mailbox —
 * emailAddress is globally unique so two workspaces can never race to
 * process (and trash) the same email. API tokens are stored encrypted
 * (token-crypto.server.ts), never in the clear.
 */

/** Row shape the Settings UI and later phases need (never the token). */
export interface EmailConnectionView extends EmailConnectionRecord {
  /** Expenses created from this connection's mail in the last 24h. */
  processedLast24h: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function toView(
  row: {
    id: string;
    provider: string;
    emailAddress: string;
    status: string;
    receivedCount: number;
    processedCount: number;
    lastPushAt: string | null;
    createdAt: string;
  },
  processedLast24h: number,
): EmailConnectionView {
  return {
    id: row.id,
    provider: row.provider,
    emailAddress: row.emailAddress,
    status: row.status,
    receivedCount: row.receivedCount,
    processedCount: row.processedCount,
    lastPushAt: row.lastPushAt,
    createdAt: row.createdAt,
    processedLast24h,
  };
}

const CONNECTION_SELECT = {
  id: true,
  provider: true,
  emailAddress: true,
  status: true,
  receivedCount: true,
  processedCount: true,
  lastPushAt: true,
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
  const counts = await prisma.emailProcessLog.groupBy({
    by: ["connectionId"],
    where: {
      connectionId: { in: rows.map((r) => r.id) },
      outcome: "created",
      createdAt: { gte: since },
    },
    _count: { _all: true },
  });
  const byConnection = new Map(
    counts.map((c) => [c.connectionId, c._count._all]),
  );
  return rows.map((row) => toView(row, byConnection.get(row.id) ?? 0));
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

/** A connection with its decrypted-ready ciphertext (server-side only). */
export async function readEmailConnection(
  id: string,
): Promise<
  | (EmailConnectionRecord & { tokenEnc: string; jmapAccountId: string })
  | undefined
> {
  const row = await prisma.emailConnection.findUnique({ where: { id } });
  if (!row) return undefined;
  return {
    id: row.id,
    provider: row.provider,
    emailAddress: row.emailAddress,
    status: row.status,
    receivedCount: row.receivedCount,
    processedCount: row.processedCount,
    lastPushAt: row.lastPushAt,
    createdAt: row.createdAt,
    tokenEnc: row.tokenEnc,
    jmapAccountId: row.jmapAccountId,
  };
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
  return { ok: true, connection: toView(row, 0) };
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
