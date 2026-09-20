import { beforeEach, describe, expect, it } from "vitest";
import {
  testPrisma,
  TEST_ACCOUNT_ID,
  OTHER_ACCOUNT_ID,
} from "./helpers/seedTestData";
import {
  addEmailRule,
  listAcceptedSenders,
  matchEmailRule,
  removeEmailRule,
  restoreEmailRule,
  ruleSenderMatches,
} from "~/lib/db/email-rules";

/** Rule store + matching. */
describe("ruleSenderMatches", () => {
  it("matches an exact address rule", () => {
    expect(
      ruleSenderMatches("receipts@stripe.com", "receipts@stripe.com"),
    ).toBe(true);
    expect(ruleSenderMatches("receipts@stripe.com", "other@stripe.com")).toBe(
      false,
    );
  });

  it("matches a domain rule on the domain and any subdomain", () => {
    expect(ruleSenderMatches("apple.com", "no_reply@email.apple.com")).toBe(
      true,
    );
    expect(ruleSenderMatches("apple.com", "apple.com@evil.com")).toBe(false);
    expect(ruleSenderMatches("apple.com", "notapple.com")).toBe(false);
  });

  it("does not match on local parts or partial domains", () => {
    expect(ruleSenderMatches("amazon.com", "user@amazon.com.evil.net")).toBe(
      false,
    );
    expect(ruleSenderMatches("amazon.com", "user@notamazon.com")).toBe(false);
  });
});

describe("email rules store", () => {
  beforeEach(async () => {
    await testPrisma.emailRule.deleteMany({});
    await testPrisma.emailRuleRemoval.deleteMany({});
  });

  it("matches general rules for any account", async () => {
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    expect(
      await matchEmailRule(TEST_ACCOUNT_ID, "No Reply <x@email.apple.com>"),
    ).toMatchObject({
      accountId: "",
      sender: "apple.com",
    });
    expect(
      await matchEmailRule(OTHER_ACCOUNT_ID, "x@email.apple.com"),
    ).toBeDefined();
  });

  it("matches user rules scoped to the workspace", async () => {
    await addEmailRule({
      accountId: TEST_ACCOUNT_ID,
      sender: "amazon.com",
      source: "forward",
    });
    expect(await matchEmailRule(TEST_ACCOUNT_ID, "a@amazon.com")).toBeDefined();
    expect(
      await matchEmailRule(OTHER_ACCOUNT_ID, "a@amazon.com"),
    ).toBeUndefined();
  });

  it("returns undefined for unknown senders and junk", async () => {
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    expect(
      await matchEmailRule(TEST_ACCOUNT_ID, "x@unknown.com"),
    ).toBeUndefined();
    expect(await matchEmailRule(TEST_ACCOUNT_ID, "")).toBeUndefined();
  });

  it("rejects invalid senders", async () => {
    expect(
      (
        await addEmailRule({
          accountId: "",
          sender: "not a rule",
          source: "seed",
        })
      ).ok,
    ).toBe(false);
    expect(
      (await addEmailRule({ accountId: "", sender: "", source: "seed" })).ok,
    ).toBe(false);
  });

  it("is idempotent per (account, sender)", async () => {
    await addEmailRule({
      accountId: TEST_ACCOUNT_ID,
      sender: "a.com",
      source: "forward",
    });
    await addEmailRule({
      accountId: TEST_ACCOUNT_ID,
      sender: "A.COM",
      source: "forward",
    });
    expect(
      await testPrisma.emailRule.count({
        where: { accountId: TEST_ACCOUNT_ID, sender: "a.com" },
      }),
    ).toBe(1);
  });
});

/** Turning a sender off (the Email page's accepted list) and turning a
 * pre-selected one back on. */
describe("email rule removals", () => {
  beforeEach(async () => {
    await testPrisma.emailRule.deleteMany({});
    await testPrisma.emailRuleRemoval.deleteMany({});
  });

  it("stops a general rule matching for the workspace that turned it off", async () => {
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    const removed = await removeEmailRule({
      accountId: TEST_ACCOUNT_ID,
      sender: "apple.com",
    });
    expect(removed.ok).toBe(true);
    // The shared rule is untouched: another workspace still files Apple mail.
    expect(
      await matchEmailRule(TEST_ACCOUNT_ID, "x@email.apple.com"),
    ).toBeUndefined();
    expect(
      await matchEmailRule(OTHER_ACCOUNT_ID, "x@email.apple.com"),
    ).toBeDefined();
  });

  it("deletes the workspace's own rule for the pattern", async () => {
    await addEmailRule({
      accountId: TEST_ACCOUNT_ID,
      sender: "amazon.com",
      source: "forward",
    });
    await removeEmailRule({ accountId: TEST_ACCOUNT_ID, sender: "amazon.com" });
    expect(
      await testPrisma.emailRule.count({
        where: { accountId: TEST_ACCOUNT_ID, sender: "amazon.com" },
      }),
    ).toBe(0);
    expect(
      await matchEmailRule(TEST_ACCOUNT_ID, "a@amazon.com"),
    ).toBeUndefined();
  });

  it("voting is per pattern: a learned subdomain rule keeps matching", async () => {
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    await addEmailRule({
      accountId: TEST_ACCOUNT_ID,
      sender: "email.apple.com",
      source: "review",
    });
    await removeEmailRule({ accountId: TEST_ACCOUNT_ID, sender: "apple.com" });
    expect(
      await matchEmailRule(TEST_ACCOUNT_ID, "no_reply@email.apple.com"),
    ).toMatchObject({ sender: "email.apple.com" });
  });

  it("remembers a sender the workspace had turned off", async () => {
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    await removeEmailRule({ accountId: TEST_ACCOUNT_ID, sender: "apple.com" });
    await addEmailRule({
      accountId: TEST_ACCOUNT_ID,
      sender: "apple.com",
      source: "review",
    });
    expect(
      await testPrisma.emailRuleRemoval.count({
        where: { accountId: TEST_ACCOUNT_ID, sender: "apple.com" },
      }),
    ).toBe(0);
    expect(
      await matchEmailRule(TEST_ACCOUNT_ID, "x@email.apple.com"),
    ).toBeDefined();
  });

  it("restores a pre-selected sender", async () => {
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    await removeEmailRule({ accountId: TEST_ACCOUNT_ID, sender: "apple.com" });
    await restoreEmailRule({ accountId: TEST_ACCOUNT_ID, sender: "apple.com" });
    expect(
      await matchEmailRule(TEST_ACCOUNT_ID, "x@email.apple.com"),
    ).toBeDefined();
  });

  it("refuses a sender that is not an address or domain", async () => {
    expect(
      await removeEmailRule({
        accountId: TEST_ACCOUNT_ID,
        sender: "not a rule",
      }),
    ).toEqual({
      ok: false,
      error: '"not a rule" is not an address or domain.',
    });
  });

  it("lists one row per pattern with its origin and state", async () => {
    await addEmailRule({ accountId: "", sender: "apple.com", source: "seed" });
    await addEmailRule({
      accountId: "",
      sender: "shopify.com",
      source: "seed",
    });
    await addEmailRule({
      accountId: TEST_ACCOUNT_ID,
      sender: "amazon.com",
      source: "forward",
    });
    await removeEmailRule({
      accountId: TEST_ACCOUNT_ID,
      sender: "shopify.com",
    });
    expect(await listAcceptedSenders(TEST_ACCOUNT_ID)).toEqual([
      { sender: "amazon.com", origin: "learned", turnedOff: false },
      { sender: "apple.com", origin: "preset", turnedOff: false },
      { sender: "shopify.com", origin: "preset", turnedOff: true },
    ]);
    // The other workspace never saw the veto.
    expect(await listAcceptedSenders(OTHER_ACCOUNT_ID)).toEqual([
      { sender: "apple.com", origin: "preset", turnedOff: false },
      { sender: "shopify.com", origin: "preset", turnedOff: false },
    ]);
  });

  it("a pattern in both scopes is one learned row, and turning it off vetoes the general rule", async () => {
    await addEmailRule({
      accountId: "",
      sender: "shopify.com",
      source: "seed",
    });
    await addEmailRule({
      accountId: TEST_ACCOUNT_ID,
      sender: "shopify.com",
      source: "review",
    });
    expect(await listAcceptedSenders(TEST_ACCOUNT_ID)).toEqual([
      { sender: "shopify.com", origin: "learned", turnedOff: false },
    ]);
    await removeEmailRule({
      accountId: TEST_ACCOUNT_ID,
      sender: "shopify.com",
    });
    expect(
      await matchEmailRule(TEST_ACCOUNT_ID, "x@shopify.com"),
    ).toBeUndefined();
    expect(await listAcceptedSenders(TEST_ACCOUNT_ID)).toEqual([
      { sender: "shopify.com", origin: "preset", turnedOff: true },
    ]);
  });
});
