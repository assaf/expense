import { and } from "@prisma/orm-postgres/orm-client";
import { db } from "~/lib/prisma.server";
import { fromIso, nowWire, toIso, toIsoOrNull } from "~/lib/db/wire";
import type {
  OAuthClientRecord,
  OAuthCodeRecord,
  OAuthTokenRecord,
} from "~/lib/types";

// --- OAuth (MCP authorization server) -------------------------------------

/**
 * Register an OAuth client (RFC 7591 dynamic registration). The raw client
 * secret is never stored; only its SHA-256 hash. Returns the record; the
 * caller hands the secret to the client exactly once.
 */
export async function registerOAuthClient(input: {
  id: string;
  secretHash: string | null;
  name: string;
  redirectUris: string[];
  authMethod: OAuthClientRecord["authMethod"];
}): Promise<OAuthClientRecord> {
  const client: OAuthClientRecord = {
    id: input.id,
    secretHash: input.secretHash,
    name: input.name,
    redirectUris: input.redirectUris,
    authMethod: input.authMethod,
    createdAt: new Date().toISOString(),
  };
  await db.orm.public.OAuthClient.create({
    id: client.id,
    secretHash: client.secretHash,
    name: client.name,
    redirectUris: JSON.stringify(client.redirectUris),
    authMethod: client.authMethod,
    createdAt: fromIso(client.createdAt),
  });
  return client;
}

/** Look up a registered OAuth client, or undefined when unknown. */
export async function findOAuthClient(
  clientId: string,
): Promise<OAuthClientRecord | undefined> {
  const row = await db.orm.public.OAuthClient.first({ id: clientId });
  if (!row) return undefined;
  return oauthClientFromRow(row);
}

/** Record that a user approved a client (idempotent). */
export async function saveOAuthConsent(
  userId: string,
  clientId: string,
): Promise<void> {
  await db.orm.public.OAuthConsent.upsert({
    update: { grantedAt: nowWire() },
    create: {
      userId,
      clientId,
      grantedAt: nowWire(),
    },
    conflictOn: { userId, clientId },
  });
}

/** True when the user already approved this client. */
export async function hasOAuthConsent(
  userId: string,
  clientId: string,
): Promise<boolean> {
  const row = await db.orm.public.OAuthConsent.where((c) =>
    and(c.userId.eq(userId), c.clientId.eq(clientId)),
  )
    .select("userId")
    .first();
  return row !== null;
}

/** Store an authorization code (id is the sha256 of the raw code). */
export async function createOAuthCode(input: {
  id: string;
  userId: string;
  clientId: string;
  challenge: string;
  redirectUri: string;
  expiresAt: string;
}): Promise<void> {
  await db.orm.public.OAuthCode.create({
    ...input,
    expiresAt: fromIso(input.expiresAt),
    used: false,
    createdAt: nowWire(),
  });
}

/**
 * Claim a code for exchange: marks it used atomically (single-use) and
 * returns it, or undefined when the code is unknown, already used, or
 * expired. The `used: false` predicate makes the claim race-safe.
 */
export async function consumeOAuthCode(
  id: string,
  clientId: string,
): Promise<OAuthCodeRecord | undefined> {
  const now = new Date().toISOString();
  const claimed = await db.orm.public.OAuthCode.where((c) =>
    and(
      c.id.eq(id),
      c.clientId.eq(clientId),
      c.used.eq(false),
      c.expiresAt.gt(fromIso(now)),
    ),
  ).updateAll({ used: true });
  if (claimed.length === 0) return undefined;
  const row = await db.orm.public.OAuthCode.first({ id });
  if (!row) return undefined;
  return {
    id: row.id,
    userId: row.userId,
    clientId: row.clientId,
    challenge: row.challenge,
    redirectUri: row.redirectUri,
    expiresAt: toIso(row.expiresAt),
  };
}

/** Store an access or refresh token; also sweeps expired rows (cheap). */
export async function createOAuthToken(input: {
  tokenHash: string;
  userId: string;
  clientId: string;
  type: OAuthTokenRecord["type"];
  scope: string;
  expiresAt: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.orm.public.OAuthCode.where((c) =>
      c.expiresAt.lt(fromIso(now)),
    ).deleteAll();
    await tx.orm.public.OAuthToken.where((t) =>
      and(t.expiresAt.lt(fromIso(now)), t.revokedAt.isNull()),
    ).deleteAll();
    await tx.orm.public.OAuthToken.create({
      tokenHash: input.tokenHash,
      userId: input.userId,
      clientId: input.clientId,
      _type: input.type,
      scope: input.scope,
      expiresAt: fromIso(input.expiresAt),
      revokedAt: null,
      createdAt: fromIso(now),
    });
  });
}

/** Look up a token by its stored hash. */
export async function findOAuthToken(
  tokenHash: string,
): Promise<OAuthTokenRecord | undefined> {
  const row = await db.orm.public.OAuthToken.first({ tokenHash });
  if (!row) return undefined;
  return oauthTokenFromRow(row);
}

/** Mark a token revoked (refresh rotation, disconnect, revocation endpoint). */
export async function revokeOAuthToken(tokenHash: string): Promise<void> {
  await db.orm.public.OAuthToken.where((t) =>
    and(t.tokenHash.eq(tokenHash), t.revokedAt.isNull()),
  ).updateAll({ revokedAt: nowWire() });
}

/**
 * The OAuth clients this user has connected, with activity summary for
 * the Settings → Agents & API "connected apps" list. Individual tokens are not
 * exposed here: the UI shows the app, when it was last used (the most recent
 * token issuance for this client; access tokens are minted on every
 * session/refresh), and when its access expires (the furthest expiry among
 * still-active tokens; null when the connection has no live tokens).
 */
export async function listUserOAuthSessions(userId: string): Promise<
  {
    client: OAuthClientRecord;
    lastUsedAt: string | null;
    expiresAt: string | null;
  }[]
> {
  const consents = await db.orm.public.OAuthConsent.where((c) =>
    c.userId.eq(userId),
  )
    .orderBy((c) => c.grantedAt.desc())
    .select("clientId")
    .all();
  if (consents.length === 0) return [];
  const [clients, tokens] = await Promise.all([
    db.orm.public.OAuthClient.where((c) =>
      c.id.in(consents.map((x) => x.clientId)),
    ).all(),
    db.orm.public.OAuthToken.where((t) => t.userId.eq(userId)).all(),
  ]);
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const now = new Date().toISOString();
  const out: {
    client: OAuthClientRecord;
    lastUsedAt: string | null;
    expiresAt: string | null;
  }[] = [];
  for (const consent of consents) {
    const row = clientById.get(consent.clientId);
    if (!row) continue;
    const own = tokens.filter((t) => t.clientId === consent.clientId);
    const lastUsedAt = own.reduce<string | null>(
      (latest, t) =>
        toIso(t.createdAt) > (latest ?? "") ? toIso(t.createdAt) : latest,
      null,
    );
    const active = own.filter(
      (t) => t.revokedAt === null && toIso(t.expiresAt) > now,
    );
    const expiresAt = active.reduce<string | null>(
      (latest, t) =>
        toIso(t.expiresAt) > (latest ?? "") ? toIso(t.expiresAt) : latest,
      null,
    );
    out.push({ client: oauthClientFromRow(row), lastUsedAt, expiresAt });
  }
  return out;
}

/** Delete a registered OAuth client entirely (cascades codes/tokens/consents). */
export async function deleteOAuthClient(clientId: string): Promise<void> {
  await db.orm.public.OAuthClient.where((c) => c.id.eq(clientId)).deleteAll();
}

/**
 * Disconnect a client: revoke every live token for this user + client and
 * drop the consent. The client's next token use is rejected.
 */
export async function disconnectOAuthClient(
  userId: string,
  clientId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.orm.public.OAuthToken.where((t) =>
      and(t.userId.eq(userId), t.clientId.eq(clientId), t.revokedAt.isNull()),
    ).updateAll({ revokedAt: nowWire() });
    await tx.orm.public.OAuthConsent.where((c) =>
      and(c.userId.eq(userId), c.clientId.eq(clientId)),
    ).deleteAll();
  });
}

function oauthClientFromRow(row: {
  id: string;
  secretHash: string | null;
  name: string;
  redirectUris: string;
  authMethod: string;
  createdAt: string;
}): OAuthClientRecord {
  let redirectUris: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.redirectUris);
    if (Array.isArray(parsed)) {
      redirectUris = parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // malformed stored JSON; treat as no redirect URIs
  }
  return {
    id: row.id,
    secretHash: row.secretHash,
    name: row.name,
    redirectUris,
    authMethod:
      row.authMethod === "client_secret_basic" ? "client_secret_basic" : "none",
    createdAt: toIso(row.createdAt),
  };
}

function oauthTokenFromRow(row: {
  tokenHash: string;
  userId: string;
  clientId: string;
  _type: string;
  scope: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}): OAuthTokenRecord {
  return {
    tokenHash: row.tokenHash,
    userId: row.userId,
    clientId: row.clientId,
    type: row._type === "refresh" ? "refresh" : "access",
    scope: row.scope,
    expiresAt: toIso(row.expiresAt),
    revokedAt: toIsoOrNull(row.revokedAt),
    createdAt: toIso(row.createdAt),
  };
}
