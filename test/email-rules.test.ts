import { beforeEach, describe, expect, it } from "vitest";
import {
  testPrisma,
  TEST_ACCOUNT_ID,
  OTHER_ACCOUNT_ID,
} from "./helpers/seedTestData";
import {
  addEmailRule,
  matchEmailRule,
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
