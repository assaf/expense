import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { expect as pwExpect } from "playwright/test";
import type { Page } from "playwright";
import { ulid } from "ulid";
import {
  OTHER_ACCOUNT_ID,
  TEST_ACCOUNT_ID,
  TEST_EMAIL,
  TEST_PASSWORD,
  seedTestData,
  testPrisma,
} from "./helpers/seedTestData";
import { freshPage, closeBrowser, signIn } from "./helpers/launchBrowser";
import { createAccount, createUser } from "~/lib/db/accounts";
import { createEmailConnection } from "~/lib/db/email-connections";
import { createAccountWithUser } from "~/lib/auth.server";
import { verifyJmapToken } from "~/lib/jmap.server";
import {
  completeOnboarding,
  verifyOnboardingToken,
} from "~/lib/onboarding.server";
import { hashPassword } from "~/lib/passwords";
import { decryptSecret, encryptSecret } from "~/lib/token-crypto.server";
import { action } from "~/routes/onboarding";

/**
 * FastMail onboarding (/onboarding): the token is the credential, so the
 * JMAP session call is mocked; the store tests cover the real connect
 * path (see email-connections.test.ts). EMAIL_TOKEN_ENCRYPTION_KEY comes
 * from the vitest main-project env (fixed test key).
 */

vi.mock("~/lib/jmap.server", () => ({
  verifyJmapToken: vi.fn(),
}));

const mockedVerify = vi.mocked(verifyJmapToken);

const PASSWORD = "correct horse battery staple";

function mockToken(email: string) {
  mockedVerify.mockResolvedValue({
    ok: true,
    info: {
      username: email,
      mailAccountId: "jmap-acct-1",
      apiUrl: "https://api.fastmail.com/jmap/",
      uploadUrl: "https://api.fastmail.com/upload/",
      downloadUrl: "https://api.fastmail.com/download/",
    },
  });
}

async function seedVerifiedUser(email: string, password = PASSWORD) {
  const account = await createAccount(`Attach ${ulid()}`);
  const user = await createUser({
    accountId: account.id,
    email,
    passwordHash: await hashPassword(password),
    emailVerifiedAt: new Date().toISOString(),
  });
  return { account, user };
}

describe("FastMail onboarding", () => {
  beforeEach(() => {
    mockedVerify.mockReset();
  });

  it("creates a verified account, derives the name, connects the mailbox, and signs in", async () => {
    const email = "alex.jones@example.com";
    mockToken(email);
    const outcome = await completeOnboarding({
      token: "fmu1-tok",
      email,
      password: PASSWORD,
    });

    // No verification email needed: the token proved mailbox control.
    const user = await testPrisma.user.findUnique({ where: { email } });
    expect(user).not.toBeNull();
    expect(user!.emailVerifiedAt).not.toBeNull();

    // Account name derived from the email local part.
    const account = await testPrisma.account.findUnique({
      where: { id: user!.accountId },
    });
    expect(account!.name).toBe("Alex Jones");

    // Mailbox connected to the new account.
    const connection = await testPrisma.emailConnection.findFirst({
      where: { accountId: user!.accountId },
    });
    expect(connection?.emailAddress).toBe(email);

    // The login email is a VERIFIED receipts-by-email sender, no link.
    const sender = await testPrisma.inboundSenderVerification.findUnique({
      where: { address: email },
    });
    expect(sender?.accountId).toBe(user!.accountId);

    // The home page shows its welcome panel (hidden for other accounts).
    const welcome = await testPrisma.settings.findFirst({
      where: { accountId: user!.accountId, key: "welcomePending" },
    });
    expect(welcome?.value).toBe("1");

    expect(outcome.email).toBe(email);
    expect(outcome.sessionCookie).toContain("expense_session");
  });

  it("attaches the mailbox to an existing verified account with the right password", async () => {
    const email = "sam.parker@example.com";
    const { account } = await seedVerifiedUser(email);
    mockToken(email);

    const outcome = await completeOnboarding({
      token: "fmu1-tok",
      email,
      password: PASSWORD,
    });

    // Same account, no duplicate user.
    const users = await testPrisma.user.findMany({
      where: { accountId: account.id },
    });
    expect(users).toHaveLength(1);
    const connection = await testPrisma.emailConnection.findFirst({
      where: { accountId: account.id },
    });
    expect(connection?.emailAddress).toBe(email);
    // Account email == mailbox → the sender is claimed as verified too.
    const sender = await testPrisma.inboundSenderVerification.findUnique({
      where: { address: email },
    });
    expect(sender?.accountId).toBe(account.id);
    const welcome = await testPrisma.settings.findFirst({
      where: { accountId: account.id, key: "welcomePending" },
    });
    expect(welcome?.value).toBe("1");
    expect(outcome.sessionCookie).toContain("expense_session");
  });

  it("attaches to the account the user signs in with, even when the mailbox address differs", async () => {
    // The user's real account email is NOT the mailbox address (e.g. a
    // bootstrap account owns the mailbox address). Signing in with the
    // real account must connect the mailbox to THAT account.
    const mailbox = "bootstrap.owner@example.com";
    const loginEmail = "real.user@example.com";
    mockToken(mailbox);
    const { account } = await seedVerifiedUser(loginEmail, PASSWORD);

    const outcome = await completeOnboarding({
      token: "fmu1-tok",
      email: loginEmail,
      password: PASSWORD,
    });

    const connection = await testPrisma.emailConnection.findFirst({
      where: { accountId: account.id },
    });
    expect(connection?.emailAddress).toBe(mailbox);
    expect(outcome.email).toBe(mailbox);
    expect(outcome.sessionCookie).toContain("expense_session");
    // The welcome panel goes to the account that was signed in to.
    const welcome = await testPrisma.settings.findFirst({
      where: { accountId: account.id, key: "welcomePending" },
    });
    expect(welcome?.value).toBe("1");
    // The sender claim applies only when the account email IS the mailbox
    // (the token proves control of the mailbox, not of other addresses).
    const sender = await testPrisma.inboundSenderVerification.findUnique({
      where: { address: mailbox },
    });
    expect(sender).toBeNull();
  });

  it("rejects a wrong password on attach and leaves no connection", async () => {
    const email = "wrong.pass@example.com";
    await seedVerifiedUser(email, PASSWORD);
    mockToken(email);

    await expect(
      completeOnboarding({
        token: "fmu1-tok",
        email,
        password: "definitely-not-it",
      }),
    ).rejects.toThrow("Invalid email or password");

    const connection = await testPrisma.emailConnection.findFirst({
      where: { emailAddress: email },
    });
    expect(connection).toBeNull();
  });

  it("replaces a stale unverified signup", async () => {
    const email = "pending.user@example.com";
    await createAccountWithUser({
      accountName: "Pending Old",
      email,
      password: PASSWORD,
    });
    mockToken(email);

    const outcome = await completeOnboarding({
      token: "fmu1-tok",
      email,
      password: PASSWORD,
    });

    const user = await testPrisma.user.findUnique({ where: { email } });
    expect(user?.emailVerifiedAt).not.toBeNull();
    const account = await testPrisma.account.findUnique({
      where: { id: user!.accountId },
    });
    // Fresh account named from the email, not the stale signup's name.
    expect(account?.name).toBe("Pending User");
    expect(outcome.sessionCookie).toContain("expense_session");
  });

  it("refuses a mailbox already connected to another workspace and leaves no account", async () => {
    const email = "claimed.mailbox@example.com";
    await createEmailConnection({
      accountId: OTHER_ACCOUNT_ID,
      provider: "fastmail",
      emailAddress: email,
      remoteAccountId: "jmap-other",
      tokenEnc: encryptSecret("other-token"),
    });
    mockToken(email);

    await expect(
      completeOnboarding({
        token: "fmu1-tok",
        email,
        password: PASSWORD,
      }),
    ).rejects.toThrow(/already connected to another workspace/);

    // The half-onboarded account was cleaned up.
    const user = await testPrisma.user.findUnique({ where: { email } });
    expect(user).toBeNull();
  });

  it("rejects an email that fails signup validation", async () => {
    const mailbox = "bad.email@example.com";
    mockToken(mailbox);
    await expect(
      completeOnboarding({
        token: "fmu1-tok",
        email: "not-an-email",
        password: PASSWORD,
      }),
    ).rejects.toThrow("Enter a valid email address");
  });

  it("refuses to create an account for an email the token did not verify", async () => {
    // The token proves control of the mailbox only; an arbitrary typed
    // email must never get emailVerifiedAt stamped (signup squatting).
    const mailbox = "token.owner@example.com";
    const otherEmail = "someone.else@example.com";
    mockToken(mailbox);
    await expect(
      completeOnboarding({
        token: "fmu1-tok",
        email: otherEmail,
        password: PASSWORD,
      }),
    ).rejects.toThrow(/only verifies/);
    const user = await testPrisma.user.findUnique({
      where: { email: otherEmail },
    });
    expect(user).toBeNull();
  });

  it("classifies the token's address as none / verified / unverified", async () => {
    const fresh = `fresh-${ulid().toLowerCase()}@example.com`;
    mockToken(fresh);
    expect(await verifyOnboardingToken("tok")).toEqual({
      ok: true,
      email: fresh,
      existing: "none",
    });

    const verifiedEmail = "classify.verified@example.com";
    await seedVerifiedUser(verifiedEmail);
    mockToken(verifiedEmail);
    expect(await verifyOnboardingToken("tok")).toEqual({
      ok: true,
      email: verifiedEmail,
      existing: "verified",
    });

    const pendingEmail = "classify.pending@example.com";
    await createAccountWithUser({
      accountName: "Classify Pending",
      email: pendingEmail,
      password: PASSWORD,
    });
    mockToken(pendingEmail);
    expect(await verifyOnboardingToken("tok")).toEqual({
      ok: true,
      email: pendingEmail,
      existing: "unverified",
    });
  });

  it("surfaces FastMail token errors", async () => {
    mockedVerify.mockResolvedValue({
      ok: false,
      reason: "invalid-token",
      message: "FastMail rejected this token — check it and try again.",
    });
    expect(await verifyOnboardingToken("bad")).toEqual({
      ok: false,
      error: "FastMail rejected this token — check it and try again.",
    });
    await expect(
      completeOnboarding({
        token: "bad",
        email: "nobody@example.com",
        password: PASSWORD,
      }),
    ).rejects.toThrow("FastMail rejected this token");
  });

  it("keeps an existing connection when a verified account attaches", async () => {
    // Regression: attaching must not create a second connection row for
    // the same mailbox (the global unique index would reject it).
    const email = "keep.connection@example.com";
    const { account } = await seedVerifiedUser(email);
    await createEmailConnection({
      accountId: account.id,
      provider: "fastmail",
      emailAddress: email,
      remoteAccountId: "jmap-1",
      tokenEnc: encryptSecret("tok-1"),
    });
    mockToken(email);
    await expect(
      completeOnboarding({
        token: "fmu1-tok",
        email,
        password: PASSWORD,
      }),
    ).rejects.toThrow(/already connected/);
  });
});

// The app's own test account must stay usable for the rest of the suite.
afterAll(async () => {
  await testPrisma.$disconnect();
});

/**
 * Browser-level coverage of the onboarding surface: the login-page entry,
 * the /onboarding first step, and the welcome panel lifecycle. The full
 * token→account flow can't run here (the live server can't reach FastMail
 * or mock the JMAP call). That logic is covered by the unit tests above.
 */
describe("FastMail onboarding UI", () => {
  afterAll(async () => {
    await closeBrowser();
  });

  async function openPage(): Promise<Page> {
    return freshPage();
  }

  it("links from the sign-up flow into the FastMail onboarding", async () => {
    await seedTestData();
    const page = await openPage();
    await page.goto("/login?mode=create", { waitUntil: "load" });
    await page
      .getByRole("link", { name: /Connect your FastMail account/ })
      .click();
    await pwExpect(page).toHaveURL(/\/onboarding/);
    await pwExpect(
      page.getByRole("heading", { name: "Connect your email account" }),
    ).toBeVisible();
    await pwExpect(page.getByLabel("FastMail API token")).toBeVisible();
    await page.close();
  });

  it("shows the welcome panel for an onboarded account and dismisses it for good", async () => {
    await seedTestData();
    // Flag the account the way completeOnboarding does (the server's
    // settings cache is empty until the first home-page read).
    await testPrisma.settings.create({
      data: {
        accountId: TEST_ACCOUNT_ID,
        key: "welcomePending",
        value: "1",
      },
    });

    const page = await openPage();
    await signIn(page, TEST_EMAIL, TEST_PASSWORD);
    await pwExpect(page.getByText("You're all set")).toBeVisible();

    // Dismiss → panel hides immediately and the setting persists.
    await page.getByRole("button", { name: "Dismiss welcome message" }).click();
    await pwExpect(page.getByText("You're all set")).not.toBeVisible();
    const row = await testPrisma.settings.findFirst({
      where: { accountId: TEST_ACCOUNT_ID, key: "welcomePending" },
    });
    pwExpect(row?.value).not.toBe("1");

    // Reload → still gone (read from the persisted setting).
    await page.reload({ waitUntil: "load" });
    await pwExpect(page.getByText("You're all set")).not.toBeVisible();
    await page.close();
  });

  it("never shows the welcome panel to an account that did not onboard", async () => {
    await seedTestData();
    const page = await openPage();
    await pwExpect(page.getByText("You're all set")).not.toBeVisible();
    await page.close();
  });
});

describe("FastMail onboarding route throttle", () => {
  it("caps create/attach attempts per IP like the other anonymous surfaces", async () => {
    // The route action records the attempt before the work (a FastMail
    // session call), so five attempts burn the per-IP budget and the sixth
    // is locked before any outbound call. Mirror of the reset-password cap
    // test; the route action is called directly with the same mocked
    // verify the lib tests above use.
    mockedVerify.mockResolvedValue({
      ok: false,
      reason: "invalid-token",
      message: "FastMail rejected this token — check it and try again.",
    });
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 2}`;
    const attempt = () => {
      const form = new FormData();
      form.set("intent", "create");
      form.set("token", `fmu1-wrong-${ulid()}`);
      form.set("email", `onboard-${ulid().toLowerCase()}@example.com`);
      form.set("password", PASSWORD);
      return action({
        request: new Request("http://localhost/onboarding", {
          method: "POST",
          body: form,
          headers: { "x-forwarded-for": ip },
        }),
        params: {},
        context: {},
      } as Parameters<typeof action>[0]);
    };
    for (let i = 0; i < 5; i++) {
      // React Router's data() returns { data, init } rather than a
      // Response when the action is called directly.
      const res = (await attempt()) as {
        data?: { error?: string };
        init?: ResponseInit;
      };
      expect(res.init?.status ?? 200).toBe(200);
      expect(res.data?.error).toMatch(/FastMail rejected/);
    }
    await expect(attempt()).rejects.toThrow(/Too many failed attempts/);
  });
});
import { sessionStorage } from "~/lib/auth.server";
import { GOOGLE_PENDING_SESSION_KEY } from "~/lib/google-oauth.server";
import type { Route as OnboardingRoute } from "+types/app/routes/+types/onboarding";

describe("Gmail onboarding via googlePending", () => {
  function onboardForm(
    intent: string,
    email: string,
    cookie?: string,
  ): Request {
    const form = new FormData();
    form.set("intent", intent);
    form.set("email", email);
    form.set("password", PASSWORD);
    return new Request("https://expense.test/onboarding", {
      method: "POST",
      body: form,
      headers: cookie ? { cookie } : {},
    });
  }

  it("creates a verified account from the parked Gmail credentials", async () => {
    const address = `gmail.pending.${ulid().toLowerCase()}@example.com`;
    const session = await sessionStorage.getSession();
    session.set(GOOGLE_PENDING_SESSION_KEY, {
      emailAddress: address,
      remoteAccountId: "google-sub-9",
      tokenEnc: encryptSecret("gmail-at"),
      refreshTokenEnc: encryptSecret("gmail-rt"),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const cookie = await sessionStorage.commitSession(session);
    const res = (await action({
      request: onboardForm("create", address, cookie),
    } as OnboardingRoute.ActionArgs)) as Response;

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(
      "/email-review?onboarding=1&connection=",
    );
    const user = await testPrisma.user.findUnique({
      where: { email: address },
    });
    expect(user?.emailVerifiedAt).not.toBeNull();
    const connection = await testPrisma.emailConnection.findUniqueOrThrow({
      where: { emailAddress: address },
    });
    expect(connection.provider).toBe("gmail");
    expect(connection.remoteAccountId).toBe("google-sub-9");
    expect(decryptSecret(String(connection.tokenEnc))).toBe("gmail-at");
    expect(decryptSecret(String(connection.refreshTokenEnc))).toBe("gmail-rt");
  });
});
