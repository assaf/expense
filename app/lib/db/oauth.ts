import prisma from "~/lib/prisma.server";
import type {
  OAuthClientRecord,
  OAuthCodeRecord,
  OAuthTokenRecord,
} from "~/lib/types";

// --- OAuth (MCP authorization server) -------------------------------------

/**
 * Register an OAuth client (RFC 7591 dynamic registration). The raw client
 * secret is never stored — only its SHA-256 hash. Returns the record; the
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
  await prisma.oAuthClient.create({
    data: {
      id: client.id,
      secretHash: client.secretHash,
      name: client.name,
      redirectUris: JSON.stringify(client.redirectUris),
      authMethod: client.authMethod,
      createdAt: client.createdAt,
    },
  });
  return client;
}

/** Look up a registered OAuth client, or undefined when unknown. */
export async function findOAuthClient(
  clientId: string,
): Promise<OAuthClientRecord | undefined> {
  const row = await prisma.oAuthClient.findUnique({ where: { id: clientId } });
  if (!row) return undefined;
  return oauthClientFromRow(row);
}

/** Record that a user approved a client (idempotent). */
export async function saveOAuthConsent(
  userId: string,
  clientId: string,
): Promise<void> {
  await prisma.oAuthConsent.upsert({
    where: { userId_clientId: { userId, clientId } },
    update: { grantedAt: new Date().toISOString() },
    create: {
      userId,
      clientId,
      grantedAt: new Date().toISOString(),
    },
  });
}

/** True when the user already approved this client. */
export async function hasOAuthConsent(
  userId: string,
  clientId: string,
): Promise<boolean> {
  const row = await prisma.oAuthConsent.findUnique({
    where: { userId_clientId: { userId, clientId } },
    select: { userId: true },
  });
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
  await prisma.oAuthCode.create({
    data: {
      ...input,
      used: false,
      createdAt: new Date().toISOString(),
    },
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
  const claimed = await prisma.oAuthCode.updateMany({
    where: {
      id,
      clientId,
      used: false,
      expiresAt: { gt: new Date().toISOString() },
    },
    data: { used: true },
  });
  if (claimed.count === 0) return undefined;
  const row = await prisma.oAuthCode.findUnique({ where: { id } });
  if (!row) return undefined;
  return {
    id: row.id,
    userId: row.userId,
    clientId: row.clientId,
    challenge: row.challenge,
    redirectUri: row.redirectUri,
    expiresAt: row.expiresAt,
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
  await prisma.$transaction([
    prisma.oAuthCode.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.oAuthToken.deleteMany({
      where: { expiresAt: { lt: now }, revokedAt: null },
    }),
    prisma.oAuthToken.create({
      data: { ...input, revokedAt: null, createdAt: now },
    }),
  ]);
}

/** Look up a token by its stored hash. */
export async function findOAuthToken(
  tokenHash: string,
): Promise<OAuthTokenRecord | undefined> {
  const row = await prisma.oAuthToken.findUnique({ where: { tokenHash } });
  if (!row) return undefined;
  return oauthTokenFromRow(row);
}

/** Mark a token revoked (refresh rotation, disconnect, revocation endpoint). */
export async function revokeOAuthToken(tokenHash: string): Promise<void> {
  await prisma.oAuthToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date().toISOString() },
  });
}

/**
 * The OAuth clients this user has connected, with activity summary — the
 * Settings → Agents & API "connected apps" list. Individual tokens are not
 * exposed here: the UI shows the app, when it was last used (the most recent
 * token issuance for this client — access tokens are minted on every
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
  const consents = await prisma.oAuthConsent.findMany({
    where: { userId },
    orderBy: { grantedAt: "desc" },
    select: { clientId: true },
  });
  if (consents.length === 0) return [];
  const [clients, tokens] = await Promise.all([
    prisma.oAuthClient.findMany({
      where: { id: { in: consents.map((c) => c.clientId) } },
    }),
    prisma.oAuthToken.findMany({ where: { userId } }),
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
      (latest, t) => (t.createdAt > (latest ?? "") ? t.createdAt : latest),
      null,
    );
    const active = own.filter((t) => t.revokedAt === null && t.expiresAt > now);
    const expiresAt = active.reduce<string | null>(
      (latest, t) => (t.expiresAt > (latest ?? "") ? t.expiresAt : latest),
      null,
    );
    out.push({ client: oauthClientFromRow(row), lastUsedAt, expiresAt });
  }
  return out;
}

/** Delete a registered OAuth client entirely (cascades codes/tokens/consents). */
export async function deleteOAuthClient(clientId: string): Promise<void> {
  await prisma.oAuthClient.deleteMany({ where: { id: clientId } });
}

/**
 * Disconnect a client: revoke every live token for this user + client and
 * drop the consent. The client's next token use is rejected.
 */
export async function disconnectOAuthClient(
  userId: string,
  clientId: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.oAuthToken.updateMany({
      where: { userId, clientId, revokedAt: null },
      data: { revokedAt: new Date().toISOString() },
    }),
    prisma.oAuthConsent.deleteMany({ where: { userId, clientId } }),
  ]);
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
    // malformed stored JSON — treat as no redirect URIs
  }
  return {
    id: row.id,
    secretHash: row.secretHash,
    name: row.name,
    redirectUris,
    authMethod:
      row.authMethod === "client_secret_basic" ? "client_secret_basic" : "none",
    createdAt: row.createdAt,
  };
}

function oauthTokenFromRow(row: {
  tokenHash: string;
  userId: string;
  clientId: string;
  type: string;
  scope: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}): OAuthTokenRecord {
  return {
    tokenHash: row.tokenHash,
    userId: row.userId,
    clientId: row.clientId,
    type: row.type === "refresh" ? "refresh" : "access",
    scope: row.scope,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}
