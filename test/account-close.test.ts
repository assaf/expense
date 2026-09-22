import { describe, expect, it } from "vite-plus/test";
import { expect as pwExpect } from "playwright/test";
import { hashPassword } from "~/lib/passwords";
import { db } from "~/lib/prisma.server";
import { asJson, nowWire } from "~/lib/db/wire";
import { action } from "~/routes/settings";
import { sessionStorage, SESSION_USER_KEY } from "~/lib/auth.server";
import {
  OTHER_ACCOUNT_ID,
  TEST_ACCOUNT_ID,
  TEST_PASSWORD,
  testPrisma,
} from "./helpers/seedTestData";
import { freshPage, signIn, waitForHydration } from "./helpers/launchBrowser";
import type { Route as SettingsRoute } from "+types/app/routes/+types/settings";
import { contextForRequest } from "./helpers/authContext";

/**
 * Closing your own account from Settings: the password re-check, the
 * last-member teardown (the account and everything in it), the member case
 * (only that login leaves), and the dead session a closed login leaves
 * behind.
 *
 * The tests mutate shared seed state, so they run in order: the leaver and
 * the session-death case both leave acct_test1 standing, and the last-member
 * teardown runs after them.
 */

const BASE_URL = "http://127.0.0.1:5199";
const NOW = "2026-06-15T00:00:00.000Z";

/** A committed session cookie for a user id, exactly as login mints it. */
async function sessionCookie(userId: string): Promise<string> {
  const session = await sessionStorage.getSession();
  session.set(SESSION_USER_KEY, userId);
  return sessionStorage.commitSession(session);
}

/** POST the close-account intent through the route action, signed in as
 * `cookie`'s user. */
async function closeAccount(
  cookie: string,
  password: string,
): Promise<Response> {
  const form = new FormData();
  form.set("intent", "closeAccount");
  form.set("password", password);
  const request = new Request("https://expense.test/settings", {
    method: "POST",
    body: form,
    headers: { cookie },
  });
  return action({
    request,
    params: {},
    context: await contextForRequest(request),
  } as unknown as SettingsRoute.ActionArgs);
}

/** A GET against the running test server with a session cookie, without
 * following the redirect a refused session produces. */
async function getSettings(cookie: string): Promise<Response> {
  return fetch(`${BASE_URL}/settings`, {
    headers: { cookie: cookie.split(";")[0]! },
    redirect: "manual",
  });
}

describe("closing your own account", () => {
  it("refuses a wrong password and leaves the account alone", async () => {
    const expenses = await testPrisma.expense.count({
      where: { accountId: TEST_ACCOUNT_ID },
    });
    const res = await closeAccount(
      await sessionCookie("user_test1"),
      "not-the-password",
    );
    expect(await res.json()).toEqual({
      ok: false,
      error: "That password doesn't match.",
    });
    // No cookie clearing on a refusal: the session stays usable.
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await testPrisma.user.count({ where: { id: "user_test1" } })).toBe(
      1,
    );
    expect(
      await testPrisma.account.count({ where: { id: TEST_ACCOUNT_ID } }),
    ).toBe(1);
    expect(
      await testPrisma.expense.count({ where: { accountId: TEST_ACCOUNT_ID } }),
    ).toBe(expenses);
  });

  it("removes only the leaver's own rows when other members remain", async () => {
    const email = "leaver@example.com";
    await testPrisma.user.create({
      data: {
        id: "user_leaver",
        accountId: TEST_ACCOUNT_ID,
        email,
        passwordHash: await hashPassword("leaver-password"),
        emailVerifiedAt: NOW,
        createdAt: NOW,
      },
    });
    await testPrisma.inboundSender.create({
      data: { accountId: TEST_ACCOUNT_ID, address: email, createdAt: NOW },
    });
    // Two rows keyed to the user that no FK reaches: the delete has to name
    // them or they outlive their owner.
    await db.orm.public.InsightConversation.create({
      id: "conv_leaver",
      userId: "user_leaver",
      accountId: TEST_ACCOUNT_ID,
      messages: asJson([]),
      createdAt: nowWire(),
      updatedAt: nowWire(),
    });
    await db.orm.public.OAuthClient.create({
      id: "client_close_test",
      name: "Close Account Test",
      redirectUris: "[]",
      authMethod: "none",
      createdAt: nowWire(),
    });
    await db.orm.public.OAuthToken.create({
      tokenHash: "token_leaver",
      userId: "user_leaver",
      clientId: "client_close_test",
      _type: "access",
      scope: "read",
      expiresAt: nowWire(),
      createdAt: nowWire(),
    });
    const expenses = await testPrisma.expense.count({
      where: { accountId: TEST_ACCOUNT_ID },
    });

    const res = await closeAccount(
      await sessionCookie("user_leaver"),
      "leaver-password",
    );
    expect(await res.json()).toEqual({ ok: true, deleted: "user" });
    expect(await testPrisma.user.count({ where: { id: "user_leaver" } })).toBe(
      0,
    );
    expect(
      await testPrisma.inboundSender.count({
        where: { accountId: TEST_ACCOUNT_ID, address: email },
      }),
    ).toBe(0);
    expect(
      await db.orm.public.InsightConversation.where({
        id: "conv_leaver",
      }).first(),
    ).toBeNull();
    expect(
      await db.orm.public.OAuthToken.where({
        tokenHash: "token_leaver",
      }).first(),
    ).toBeNull();
    // The account, its expenses and the member who stayed are untouched.
    expect(
      await testPrisma.account.count({ where: { id: TEST_ACCOUNT_ID } }),
    ).toBe(1);
    expect(
      await testPrisma.expense.count({ where: { accountId: TEST_ACCOUNT_ID } }),
    ).toBe(expenses);
    const survivor = await getSettings(await sessionCookie("user_test1"));
    expect(survivor.status).toBe(200);
  });

  it("closes an account while the pool's other connection is busy", async () => {
    const email = "pool@example.com";
    await testPrisma.user.create({
      data: {
        id: "user_pool",
        accountId: TEST_ACCOUNT_ID,
        email,
        passwordHash: await hashPassword("pool-password"),
        emailVerifiedAt: NOW,
        createdAt: NOW,
      },
    });
    // Hold one of the pool's two connections for the length of the close,
    // the way a concurrent request does. The closing transaction takes the
    // other; it must do its whole job on that one. A read through the store
    // instead (readAccount, which the row lock used to make) asks the pool
    // for a third, waits out connectionTimeoutMillis and fails.
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx.orm.public.Account.first({ id: TEST_ACCOUNT_ID });
      acquired();
      await gate;
    });
    await ready;
    try {
      const res = await closeAccount(
        await sessionCookie("user_pool"),
        "pool-password",
      );
      expect(await res.json()).toEqual({ ok: true, deleted: "user" });
      expect(await testPrisma.user.count({ where: { id: "user_pool" } })).toBe(
        0,
      );
    } finally {
      release();
      await holder;
    }
  });

  it("refuses a closed login's cookie immediately", async () => {
    await testPrisma.user.create({
      data: {
        id: "user_warm",
        accountId: TEST_ACCOUNT_ID,
        email: "warm@example.com",
        passwordHash: await hashPassword("warm-password"),
        emailVerifiedAt: NOW,
        createdAt: NOW,
      },
    });
    const cookie = await sessionCookie("user_warm");
    // This GET puts the user in the SERVER process's user cache (30s TTL).
    // Without the deleted-epoch sentinel the epoch of a gone row reads as
    // "", the same value this never-reset session carries, so the stale
    // cached row would keep the closed login signed in.
    expect((await getSettings(cookie)).status).toBe(200);

    await closeAccount(cookie, "warm-password");

    const after = await getSettings(cookie);
    expect(after.status).toBe(302);
    expect(after.headers.get("location")).toBe("/login?next=%2Fsettings");
  });

  it("deletes the account and everything in it for the last member", async () => {
    const other = {
      users: await testPrisma.user.count({
        where: { accountId: OTHER_ACCOUNT_ID },
      }),
      expenses: await testPrisma.expense.count({
        where: { accountId: OTHER_ACCOUNT_ID },
      }),
      reports: await testPrisma.report.count({
        where: { accountId: OTHER_ACCOUNT_ID },
      }),
      categories: await testPrisma.category.count({
        where: { accountId: OTHER_ACCOUNT_ID },
      }),
    };
    // The rows an Account delete cannot reach, seeded so the assertions
    // below would catch a leak: email_rules has no relation, and
    // insight_conversations hangs off the user, not the account.
    await testPrisma.emailRule.create({
      data: {
        id: "rule_close",
        accountId: TEST_ACCOUNT_ID,
        sender: "receipts@example.com",
        source: "test",
        createdAt: NOW,
      },
    });
    await testPrisma.emailRuleRemoval.create({
      data: {
        accountId: TEST_ACCOUNT_ID,
        sender: "receipts@example.com",
        createdAt: NOW,
      },
    });
    await db.orm.public.InsightConversation.create({
      id: "conv_close",
      userId: "user_test1",
      accountId: TEST_ACCOUNT_ID,
      messages: asJson([]),
      createdAt: nowWire(),
      updatedAt: nowWire(),
    });
    // Receipt bytes and thumbnails live in image_blobs.
    await testPrisma.imageBlob.create({
      data: {
        accountId: TEST_ACCOUNT_ID,
        key: `images/${TEST_ACCOUNT_ID}/2026-01-15_test-store.png`,
        mime: "image/png",
        data: new Uint8Array([1, 2, 3]),
      },
    });

    const res = await closeAccount(
      await sessionCookie("user_test1"),
      TEST_PASSWORD,
    );
    expect(await res.json()).toEqual({ ok: true, deleted: "account" });
    // The response also ends the session it was made with.
    expect(res.headers.get("set-cookie")).toContain("expense_session=;");
    expect(res.headers.get("set-cookie")).toContain("Expires=Thu, 01 Jan 1970");

    const gone: [string, number][] = [
      [
        "account",
        await testPrisma.account.count({ where: { id: TEST_ACCOUNT_ID } }),
      ],
      [
        "users",
        await testPrisma.user.count({ where: { accountId: TEST_ACCOUNT_ID } }),
      ],
      [
        "expenses",
        await testPrisma.expense.count({
          where: { accountId: TEST_ACCOUNT_ID },
        }),
      ],
      [
        "image blobs",
        await testPrisma.imageBlob.count({
          where: { accountId: TEST_ACCOUNT_ID },
        }),
      ],
      [
        "reports",
        await testPrisma.report.count({
          where: { accountId: TEST_ACCOUNT_ID },
        }),
      ],
      [
        "categories",
        await testPrisma.category.count({
          where: { accountId: TEST_ACCOUNT_ID },
        }),
      ],
      [
        "locations",
        await testPrisma.location.count({
          where: { accountId: TEST_ACCOUNT_ID },
        }),
      ],
      [
        "email rules",
        await testPrisma.emailRule.count({
          where: { accountId: TEST_ACCOUNT_ID },
        }),
      ],
      [
        "email rule removals",
        await testPrisma.emailRuleRemoval.count({
          where: { accountId: TEST_ACCOUNT_ID },
        }),
      ],
      [
        "inbound senders",
        await testPrisma.inboundSender.count({
          where: { accountId: TEST_ACCOUNT_ID },
        }),
      ],
      [
        "conversations",
        (
          await db.orm.public.InsightConversation.where((c) =>
            c.accountId.eq(TEST_ACCOUNT_ID),
          ).aggregate((a) => ({ count: a.count() }))
        ).count,
      ],
    ];
    for (const [table, count] of gone) {
      expect(count, table).toBe(0);
    }

    // The other account is fully intact.
    expect(
      await testPrisma.user.count({ where: { accountId: OTHER_ACCOUNT_ID } }),
    ).toBe(other.users);
    expect(
      await testPrisma.expense.count({
        where: { accountId: OTHER_ACCOUNT_ID },
      }),
    ).toBe(other.expenses);
    expect(
      await testPrisma.report.count({ where: { accountId: OTHER_ACCOUNT_ID } }),
    ).toBe(other.reports);
    expect(
      await testPrisma.category.count({
        where: { accountId: OTHER_ACCOUNT_ID },
      }),
    ).toBe(other.categories);
  });

  it("closes the account from Settings, asking for the password first", async () => {
    const accountId = "acct_close_ui";
    const email = "close-ui@example.com";
    const password = "close-ui-password";
    await testPrisma.account.create({
      data: {
        id: accountId,
        name: "Close UI",
        inviteCode: "CLOSEUI1",
        createdAt: NOW,
      },
    });
    await testPrisma.user.create({
      data: {
        id: "user_close_ui",
        accountId,
        email,
        passwordHash: await hashPassword(password),
        emailVerifiedAt: NOW,
        createdAt: NOW,
      },
    });
    await testPrisma.report.create({
      data: { name: "2026 UI", accountId },
    });
    await testPrisma.expense.createMany({
      data: [
        ["2026-01-15", "Test Store", "42.50", "receipt", null],
        ["2026-02-20", "OfficeMax", "15.99", "receipt", null],
        ["2026-03-10", "", "22.40", "mileage", "32.00"],
      ].map(([date, merchant, amount, type, distanceMiles]) => ({
        id: `close_ui_${date}`,
        accountId,
        type,
        date,
        report: "2026 UI",
        category: "",
        description: "",
        amount,
        merchant,
        imageFile: "",
        imageMime: "",
        originalName: "",
        distanceMiles,
        locations: [],
        createdAt: NOW,
        updatedAt: NOW,
      })),
    });

    const page = await freshPage();
    try {
      await signIn(page, email, password);
      await page.goto("/settings", { waitUntil: "load", timeout: 15_000 });
      await waitForHydration(page);

      // The section states what closing would delete, from the live counts.
      await pwExpect(
        page.getByText("2 receipts, 1 trip and 1 report"),
      ).toBeVisible();

      await page.getByRole("button", { name: "Close my account" }).click();
      const dialog = page.locator('[role="dialog"]');
      await pwExpect(dialog).toBeVisible();
      await pwExpect(
        dialog.getByText("Everything in it is deleted, now and permanently."),
      ).toBeVisible();

      // A wrong password keeps the dialog open with the error inline.
      await dialog.locator('input[name="password"]').fill("wrong-password");
      await dialog.getByRole("button", { name: "Close my account" }).click();
      await pwExpect(
        dialog.getByText("That password doesn't match."),
      ).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/settings");

      await dialog.locator('input[name="password"]').fill(password);
      await dialog.getByRole("button", { name: "Close my account" }).click();
      await page.waitForURL((url) => url.pathname === "/login", {
        timeout: 15_000,
      });
      expect(new URL(page.url()).searchParams.get("closed")).toBe("1");
      await pwExpect(
        page.getByText(
          "Your account is closed and everything in it has been deleted.",
        ),
      ).toBeVisible();

      // A member who left a shared account lands on the other notice: their
      // login went, the account did not.
      await page.goto("/login?left=1", { waitUntil: "load", timeout: 15_000 });
      await pwExpect(page.getByText("You've left the account.")).toBeVisible();

      expect(
        await testPrisma.account.findUnique({ where: { id: accountId } }),
      ).toBeNull();
      expect(await testPrisma.expense.count({ where: { accountId } })).toBe(0);
    } finally {
      await page.close();
    }
  });
});
