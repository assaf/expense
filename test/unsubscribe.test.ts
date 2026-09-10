import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expect as pwExpect } from "playwright/test";
import type { Page } from "playwright";
import { ulid } from "ulid";
import {
  MARKETING_UNSUBSCRIBE_SALT,
  marketingUnsubscribeToken,
  marketingUnsubscribeUserId,
  marketingUnsubscribeUrl,
  signValue,
  verifySignedValue,
} from "~/lib/unsubscribe.server";
import { headers as unsubscribeHeaders } from "~/routes/unsubscribe.$token";
import {
  marketingEmailHeaders,
  marketingFooter,
} from "~/lib/email-layout.server";
import {
  createAccount,
  createUser,
  readMarketingUnsubscribed,
} from "~/lib/db/accounts";
import { TEST_EMAIL, seedTestData, testPrisma } from "./helpers/seedTestData";
import { closeBrowser, freshPage, goto } from "./helpers/launchBrowser";
import { closeServer, launchServer } from "./helpers/launchServer";

/**
 * Marketing-email unsubscribe: the permanent signed link (no login, no
 * stored token), the public confirmation→POST route (which also serves
 * RFC 8058 one-click), and the Settings resubscribe control.
 */

const PASSWORD = "correct horse battery staple";

async function seedUser(email: string) {
  const account = await createAccount(`Unsub ${ulid()}`);
  const user = await createUser({
    accountId: account.id,
    email,
    passwordHash: PASSWORD,
    emailVerifiedAt: new Date().toISOString(),
  });
  return { account, user };
}

/** Reuse the globalSetup server already listening on 5199 rather than
 * spawning a second instance. Returns whether this call launched it. */
async function ensureServer(): Promise<boolean> {
  try {
    await fetch("http://127.0.0.1:5199/login", {
      signal: AbortSignal.timeout(3_000),
    });
    return false;
  } catch {
    await launchServer();
    return true;
  }
}

describe("unsubscribe tokens", () => {
  it("round-trips a value", () => {
    const token = signValue("user-123", "some-purpose");
    expect(verifySignedValue(token, "some-purpose")).toBe("user-123");
  });

  it("rejects tampering, wrong purpose, and malformed tokens", () => {
    const token = signValue("user-123", "purpose-a");
    const [payload, signature] = token.split(".");
    // One flipped signature character breaks verification.
    const flipped = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
    expect(verifySignedValue(`${payload}.${flipped}`, "purpose-a")).toBeNull();
    // So does a flipped payload character.
    const flippedPayload =
      payload.slice(0, -1) + (payload.endsWith("A") ? "B" : "A");
    expect(
      verifySignedValue(`${flippedPayload}.${signature}`, "purpose-a"),
    ).toBeNull();
    // A token minted for another purpose never validates here.
    expect(verifySignedValue(token, "purpose-b")).toBeNull();
    // Malformed shapes.
    expect(verifySignedValue("", "purpose-a")).toBeNull();
    expect(verifySignedValue("no-signature", "purpose-a")).toBeNull();
    expect(verifySignedValue(`${token}.`, "purpose-a")).toBeNull();
  });

  it("scopes the marketing token to the user it was minted for", () => {
    expect(marketingUnsubscribeUserId(marketingUnsubscribeToken("u-1"))).toBe(
      "u-1",
    );
    expect(marketingUnsubscribeUserId(marketingUnsubscribeToken("u-2"))).toBe(
      "u-2",
    );
    // Another user's id can't be spliced into a valid token.
    const [, signature] = marketingUnsubscribeToken("u-1").split(".");
    const forged = Buffer.from("u-2").toString("base64url");
    expect(marketingUnsubscribeUserId(`${forged}.${signature}`)).toBeNull();
    expect(MARKETING_UNSUBSCRIBE_SALT).toBe("marketing-unsubscribe");
  });

  it("builds a URL on the given origin carrying the token", () => {
    const url = marketingUnsubscribeUrl("https://expense.example", "u-1");
    expect(url).toMatch(
      /^https:\/\/expense\.example\/unsubscribe\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );
  });
});

describe("marketing email helpers", () => {
  it("footer carries the unsubscribe link and headers follow RFC 8058", () => {
    const url = "https://expense.example/unsubscribe/abc.def";
    const footer = marketingFooter(url, "user@example.com");
    expect(footer).toContain(`href="${url}"`);
    expect(footer).toContain("user@example.com");
    const headers = marketingEmailHeaders(url);
    expect(headers["List-Unsubscribe"]).toBe(`<${url}>`);
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});

describe("unsubscribe route", () => {
  let launched = false;

  beforeAll(async () => {
    await seedTestData();
    launched = await ensureServer();
  });

  afterAll(async () => {
    if (launched) await closeServer();
  });

  it("confirms on GET without unsubscribing, then unsubscribes on POST", async () => {
    const email = `unsub-flow-${ulid().toLowerCase()}@example.com`;
    const { user } = await seedUser(email);
    const token = marketingUnsubscribeToken(user.id);

    const page = await freshPage();
    const res = await page.goto(`/unsubscribe/${token}`, {
      waitUntil: "load",
    });
    expect(res?.status()).toBe(200);
    await pwExpect(page.getByText(email).first()).toBeVisible();
    // Mail scanners follow GETs: the flag must still be null after the view.
    expect(await readMarketingUnsubscribed(user.id)).toBeNull();

    const post = await page.request.post(`/unsubscribe/${token}`, {
      form: {},
    });
    expect(post.status()).toBe(200);
    expect(await readMarketingUnsubscribed(user.id)).not.toBeNull();
    await page.close();
  });

  it("is idempotent: the first opt-out time wins", async () => {
    const { user } = await seedUser(
      `unsub-idem-${ulid().toLowerCase()}@example.com`,
    );
    const token = marketingUnsubscribeToken(user.id);
    const page = await freshPage();
    await page.request.post(`/unsubscribe/${token}`, { form: {} });
    const first = await readMarketingUnsubscribed(user.id);
    await page.waitForTimeout(20);
    await page.request.post(`/unsubscribe/${token}`, { form: {} });
    expect(await readMarketingUnsubscribed(user.id)).toBe(first);
    await page.close();
  });

  it("serves RFC 8058 one-click POSTs (no Origin, no session)", async () => {
    const { user } = await seedUser(
      `unsub-8058-${ulid().toLowerCase()}@example.com`,
    );
    const token = marketingUnsubscribeToken(user.id);
    const page = await freshPage();
    const res = await page.request.post(`/unsubscribe/${token}`, {
      form: { "List-Unsubscribe": "One-Click" },
    });
    expect(res.status()).toBe(200);
    expect(await readMarketingUnsubscribed(user.id)).not.toBeNull();
    await page.close();
  });

  it("rejects cross-site POSTs and invalid tokens", async () => {
    const { user } = await seedUser(
      `unsub-csrf-${ulid().toLowerCase()}@example.com`,
    );
    const token = marketingUnsubscribeToken(user.id);
    const page = await freshPage();

    const foreign = await page.request.post(`/unsubscribe/${token}`, {
      form: {},
      headers: { origin: "https://evil.example" },
    });
    // React Router's own Origin check blocks cross-site POSTs before the
    // action (400); rejectCrossSitePost would answer 403 where it runs.
    expect(foreign.status()).toBeGreaterThanOrEqual(400);
    expect(await readMarketingUnsubscribed(user.id)).toBeNull();

    for (const bad of [
      "garbage",
      `${token}-x`,
      marketingUnsubscribeToken("no-such-user"),
    ]) {
      const res = await page.request.post(`/unsubscribe/${bad}`, {
        form: {},
      });
      expect(res.status()).toBe(200);
      expect(await res.text()).toContain("Link not valid");
    }
    // A clean POST with no Origin (curl, server-to-server, one-click)
    // still unsubscribes.
    const plain = await page.request.post(`/unsubscribe/${token}`, {
      form: {},
    });
    expect(plain.status()).toBe(200);
    // The real token worked above.
    expect(await readMarketingUnsubscribed(user.id)).not.toBeNull();
    await page.close();
  });

  it("rejects a token signed for another purpose", async () => {
    const { user } = await seedUser(
      `unsub-salt-${ulid().toLowerCase()}@example.com`,
    );
    const forged = signValue(user.id, "verify-email");
    const page = await freshPage();
    const res = await page.request.post(`/unsubscribe/${forged}`, {
      form: {},
    });
    expect(await res.text()).toContain("Link not valid");
    expect(await readMarketingUnsubscribed(user.id)).toBeNull();
    await page.close();
  });
});

describe("settings marketing preference", () => {
  let launched = false;
  let page: Page;

  beforeAll(async () => {
    await seedTestData();
    launched = await ensureServer();
  });

  afterAll(async () => {
    await page?.close();
    await closeBrowser();
    if (launched) await closeServer();
    await testPrisma.$disconnect();
  });

  it("shows the status and toggles unsubscribe/resubscribe", async () => {
    page = await goto("/settings");
    const emails = page.locator("#emails");
    await pwExpect(
      emails.getByText("Subscribed", { exact: true }),
    ).toBeVisible();

    await emails.getByRole("button", { name: "Unsubscribe" }).click();
    await pwExpect(emails.getByText("Unsubscribed")).toBeVisible();
    const user = await testPrisma.user.findUniqueOrThrow({
      where: { email: TEST_EMAIL },
    });
    expect(user.marketingUnsubscribedAt).not.toBeNull();

    await emails.getByRole("button", { name: "Subscribe again" }).click();
    await pwExpect(
      emails.getByText("Subscribed", { exact: true }),
    ).toBeVisible();
    const restored = await testPrisma.user.findUniqueOrThrow({
      where: { email: TEST_EMAIL },
    });
    expect(restored.marketingUnsubscribedAt).toBeNull();
  });
});

describe("unsubscribe page headers", () => {
  it("never lets the personalized public page be cached", () => {
    expect(unsubscribeHeaders()).toEqual({
      "Cache-Control": "private, max-age=0, must-revalidate",
    });
  });
});
