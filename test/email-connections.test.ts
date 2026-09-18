import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { ulid } from "ulid";
import {
  testPrisma,
  TEST_ACCOUNT_ID,
  OTHER_ACCOUNT_ID,
} from "./helpers/seedTestData";
import {
  createEmailConnection,
  listEmailConnections,
  findEmailConnectionByAddress,
  readEmailConnection,
  readEmailConnectionById,
  listAllEmailConnections,
  removeEmailConnection,
  saveEmailConnectionSubscription,
  saveEmailConnectionWatch,
  touchEmailConnectionPush,
  setEmailConnectionStatus,
  type EmailConnectionView,
} from "~/lib/db/email-connections";
import { decryptSecret, encryptSecret } from "~/lib/token-crypto.server";

/**
 * Connected email accounts: the store layer. EMAIL_TOKEN_ENCRYPTION_KEY comes from
 * the vitest main-project env (fixed test key; see vitest.main.config.ts).
 */

const TOKEN = "fmu1-conn-tok";

async function connect(
  address = "mailbox@example.com",
  accountId = TEST_ACCOUNT_ID,
) {
  return createEmailConnection({
    accountId,
    provider: "fastmail",
    emailAddress: address,
    remoteAccountId: "jmap-acct-1",
    tokenEnc: encryptSecret(TOKEN),
  });
}

function clean() {
  return testPrisma.emailConnection.deleteMany({});
}

describe("email connections store", () => {
  beforeEach(clean);

  it("creates a connection and lists it with the token absent", async () => {
    const result = await connect();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reconnected).toBe(false);
    const list = await listEmailConnections(TEST_ACCOUNT_ID);
    expect(list).toHaveLength(1);
    expect(list[0]!.emailAddress).toBe("mailbox@example.com");
    expect(list[0]!.provider).toBe("fastmail");
    expect(list[0]!.processedLast24h).toBe(0);
    // The view shape must never carry the (encrypted) token.
    expect(Object.keys(list[0]!)).not.toContain("tokenEnc");
    expect(JSON.stringify(list)).not.toContain(TOKEN);
  });

  it("stores the token encrypted and decrypts on demand", async () => {
    await connect();
    const row = await readEmailConnection(
      TEST_ACCOUNT_ID,
      (await listEmailConnections(TEST_ACCOUNT_ID))[0]!.id,
    );
    expect(row).toBeDefined();
    expect(row!.tokenEnc).not.toContain(TOKEN);
    expect(decryptSecret(row!.tokenEnc)).toBe(TOKEN);
    expect(row!.remoteAccountId).toBe("jmap-acct-1");
  });

  it("saves the newest credentials when the same workspace reconnects", async () => {
    // Fastmail revokes the refresh token it handed out before, so the set
    // from the latest connect is the only usable one: reconnect saves it
    // over the stored row (still one row) and clears needs-attention.
    const first = await createEmailConnection({
      accountId: TEST_ACCOUNT_ID,
      provider: "fastmail",
      emailAddress: "mailbox@example.com",
      remoteAccountId: "jmap-acct-1",
      tokenEnc: encryptSecret("first-access"),
      refreshTokenEnc: encryptSecret("first-refresh"),
      tokenExpiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await setEmailConnectionStatus(first.connection.id, "error");

    const again = await connect("Mailbox@Example.com"); // case-insensitive
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.reconnected).toBe(true);
    expect(again.connection.id).toBe(first.connection.id);
    expect(await listEmailConnections(TEST_ACCOUNT_ID)).toHaveLength(1);

    const row = (await readEmailConnection(
      TEST_ACCOUNT_ID,
      first.connection.id,
    ))!;
    expect(decryptSecret(row.tokenEnc)).toBe(TOKEN);
    // A pasted token carries no refresh token, so the OAuth fields go with
    // the credentials they belonged to.
    expect(row.refreshTokenEnc).toBeNull();
    expect(row.tokenExpiresAt).toBeNull();
    expect(row.status).toBe("active");
  });

  it("stores the OAuth fields when a reconnect brings a refresh token", async () => {
    await connect();
    const again = await createEmailConnection({
      accountId: TEST_ACCOUNT_ID,
      provider: "fastmail",
      emailAddress: "mailbox@example.com",
      remoteAccountId: "jmap-acct-1",
      tokenEnc: encryptSecret("fresh-access"),
      refreshTokenEnc: encryptSecret("fresh-refresh"),
      tokenExpiresAt: "2030-02-01T00:00:00.000Z",
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const row = (await readEmailConnection(
      TEST_ACCOUNT_ID,
      again.connection.id,
    ))!;
    expect(decryptSecret(row.tokenEnc)).toBe("fresh-access");
    expect(decryptSecret(row.refreshTokenEnc!)).toBe("fresh-refresh");
    expect(row.tokenExpiresAt).toBe("2030-02-01T00:00:00.000Z");
  });

  it("reports the connection's stats on a reconnect", async () => {
    const first = await connect();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await testPrisma.emailProcessLog.create({
      data: {
        connectionId: first.connection.id,
        emailId: "e1",
        fromAddress: "apple@id.apple.com",
        subject: "Your receipt",
        matched: true,
        outcome: "created",
        createdAt: new Date().toISOString(),
      },
    });
    const again = await connect();
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.connection.processedLast24h).toBe(1);
  });

  it("rejects a mailbox claimed by another workspace", async () => {
    await connect();
    const dup = await connect("mailbox@example.com", OTHER_ACCOUNT_ID);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toMatch(/another workspace/);
  });

  it("scopes listing to the workspace", async () => {
    await connect("a@example.com", TEST_ACCOUNT_ID);
    await connect("b@example.com", OTHER_ACCOUNT_ID);
    const mine = await listEmailConnections(TEST_ACCOUNT_ID);
    expect(mine.map((c) => c.emailAddress)).toEqual(["a@example.com"]);
  });

  it("resolves ownership by address for the exclusivity check", async () => {
    expect(
      await findEmailConnectionByAddress("mailbox@example.com"),
    ).toBeUndefined();
    const connected = await connect();
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    const owner = await findEmailConnectionByAddress("MAILBOX@example.com");
    expect(owner).toEqual({
      id: connected.connection.id,
      accountId: TEST_ACCOUNT_ID,
    });
  });

  it("disconnects only within the owning workspace", async () => {
    await connect();
    const id = (await listEmailConnections(TEST_ACCOUNT_ID))[0]!.id;
    expect(await removeEmailConnection(OTHER_ACCOUNT_ID, id)).toBe(false);
    expect(await listEmailConnections(TEST_ACCOUNT_ID)).toHaveLength(1);
    expect(await removeEmailConnection(TEST_ACCOUNT_ID, id)).toBe(true);
    expect(await listEmailConnections(TEST_ACCOUNT_ID)).toHaveLength(0);
  });

  it("counts processed-in-last-24h from the process log", async () => {
    await connect();
    const list: EmailConnectionView[] =
      await listEmailConnections(TEST_ACCOUNT_ID);
    const connection = list[0]!;
    const now = new Date().toISOString();
    await testPrisma.emailProcessLog.createMany({
      data: [
        {
          connectionId: connection.id,
          emailId: "e1",
          fromAddress: "apple@id.apple.com",
          subject: "Your receipt",
          matched: true,
          outcome: "created",
          createdAt: now,
        },
        {
          connectionId: connection.id,
          emailId: "e2",
          fromAddress: "news@example.com",
          subject: "Weekly",
          matched: false,
          outcome: "ignored",
          createdAt: now,
        },
        {
          // Created, but 3 days ago, outside the 24h window.
          connectionId: connection.id,
          emailId: "e3",
          fromAddress: "apple@id.apple.com",
          subject: "Old receipt",
          matched: true,
          outcome: "created",
          createdAt: new Date(
            Date.now() - 3 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        },
      ],
    });
    const updated = await listEmailConnections(TEST_ACCOUNT_ID);
    expect(updated[0]!.processedLast24h).toBe(1);
  });

  it("reads by id only for the webhook, scoped read for the workspace", async () => {
    await connect();
    const connection = (await listEmailConnections(TEST_ACCOUNT_ID))[0]!;
    expect(await readEmailConnectionById(connection.id)).toBeDefined();
    expect(await readEmailConnectionById("nope")).toBeUndefined();
    // Workspace-scoped read rejects foreign ids.
    expect(
      await readEmailConnection(OTHER_ACCOUNT_ID, connection.id),
    ).toBeUndefined();
  });

  it("lists all connections across workspaces for the cron", async () => {
    await connect("a@example.com", TEST_ACCOUNT_ID);
    await connect("b@example.com", OTHER_ACCOUNT_ID);
    const all = await listAllEmailConnections();
    expect(all.map((c) => c.emailAddress).sort()).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
    expect(all.every((c) => "tokenEnc" in c && "remoteAccountId" in c)).toBe(
      true,
    );
  });

  it("saves subscription state, stamps pushes, and toggles status", async () => {
    await connect();
    const connection = (await listEmailConnections(TEST_ACCOUNT_ID))[0]!;
    await saveEmailConnectionSubscription(
      connection.id,
      "sub-1",
      "2030-01-01T00:00:00.000Z",
    );
    await setEmailConnectionStatus(connection.id, "error");
    await touchEmailConnectionPush(connection.id);
    const row = await readEmailConnectionById(connection.id);
    expect(row!.pushSubscriptionId).toBe("sub-1");
    expect(row!.pushExpiresAt).toBe("2030-01-01T00:00:00.000Z");
    expect(row!.status).toBe("error");
    expect(row!.lastPushAt).not.toBeNull();
    // And the view (Email page) surfaces the error status.
    const view = (await listEmailConnections(TEST_ACCOUNT_ID))[0]!;
    expect(view.status).toBe("error");
  });

  it("creates a gmail row and saves a watch expiration without an id", async () => {
    const result = await createEmailConnection({
      accountId: TEST_ACCOUNT_ID,
      provider: "gmail",
      emailAddress: `gmail.${ulid()}@example.com`,
      remoteAccountId: "google-sub-7",
      tokenEnc: encryptSecret("gmail-at"),
      refreshTokenEnc: encryptSecret("gmail-rt"),
      tokenExpiresAt: "2030-06-01T00:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    const row = await readEmailConnection(
      TEST_ACCOUNT_ID,
      result.ok ? result.connection.id : "",
    );
    expect(row!.remoteAccountId).toBe("google-sub-7");
    expect(row!.provider).toBe("gmail");
    expect(row!.tokenExpiresAt).toBe("2030-06-01T00:00:00.000Z");
    // Gmail has no subscription id; the watch saver touches only the
    // expiration.
    await saveEmailConnectionWatch(row!.id, "2030-06-02T00:00:00.000Z");
    const after = await readEmailConnectionById(row!.id);
    expect(after!.pushExpiresAt).toBe("2030-06-02T00:00:00.000Z");
    expect(after!.pushSubscriptionId).toBeNull();
  });

  it("cascades the process log when the connection is deleted", async () => {
    await connect();
    const connection = (await listEmailConnections(TEST_ACCOUNT_ID))[0]!;
    await testPrisma.emailProcessLog.create({
      data: {
        connectionId: connection.id,
        emailId: "e1",
        fromAddress: "apple@id.apple.com",
        subject: "Your receipt",
        matched: true,
        outcome: "created",
        createdAt: new Date().toISOString(),
      },
    });
    await removeEmailConnection(TEST_ACCOUNT_ID, connection.id);
    expect(await testPrisma.emailProcessLog.count()).toBe(0);
  });
});

afterAll(async () => {
  await testPrisma.$disconnect();
});
