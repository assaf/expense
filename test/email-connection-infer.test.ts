import { beforeEach, describe, expect, it, vi } from "vitest";
import { testPrisma, TEST_ACCOUNT_ID } from "./helpers/seedTestData";
import { inferRuleCandidates } from "~/lib/email-connection-infer.server";
import { addEmailRule, listGeneralEmailRules } from "~/lib/db/email-rules";

/**
 * Rule inference from a connected inbox: the JMAP transport is a scriptable
 * fake (Mailbox/get → inbox id, Email/query → ids, Email/get → entries);
 * scoring/grouping and the freemail/self exclusions are the logic under
 * test. `--apply` behavior (addEmailRule source=inferred) is covered too.
 */

const jmap = vi.hoisted(() => {
  interface FakeEntry {
    from: Array<{ email: string }>;
    subject: string;
    preview: string;
  }
  const state: { entries: FakeEntry[] } = {
    entries: [],
  };
  return {
    state,
    jmapCall: vi.fn(async (_token: string, methodCalls: unknown[][]) => {
      const [name, args] = methodCalls[0] as [string, Record<string, unknown>];
      if (name === "Mailbox/get") {
        return [
          ["Mailbox/get", { list: [{ id: "inbox-1", role: "inbox" }] }, "m0"],
        ];
      }
      if (name === "Email/query") {
        return [
          ["Email/query", { ids: state.entries.map((_, i) => `e${i}`) }, "m0"],
        ];
      }
      if (name === "Email/get") {
        return [["Email/get", { list: state.entries }, "m0"]];
      }
      throw new Error(`unexpected JMAP call ${name} ${JSON.stringify(args)}`);
    }),
  };
});

vi.mock("~/lib/jmap.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/jmap.server")>()),
  jmapCall: jmap.jmapCall,
  jmapSessionForToken: async () => ({ mailAccountId: "acct-1" }),
}));

const OWNER = "owner@example.com";

function entry(from: string, subject: string, preview: string) {
  return { from: [{ email: from }], subject, preview };
}

describe("inferRuleCandidates", () => {
  beforeEach(() => {
    jmap.state.entries = [];
    jmap.jmapCall.mockClear();
  });

  it("recommends domains whose mail is consistently receipt-like", async () => {
    jmap.state.entries = [
      entry("no_reply@email.apple.com", "Your receipt from Apple", ""),
      entry("no_reply@email.apple.com", "Your order #123", ""),
      entry("receipts@stripe.com", "Payment received", "Total: $12.00"),
      entry("receipts@stripe.com", "Your invoice", "Amount due: $8.50"),
      // Plenty of mail, but mixed — ratio below 0.5.
      entry("news@github.com", "Your weekly digest", "unsubscribe"),
      entry("news@github.com", "Security alert", "new sign-in"),
      entry("news@github.com", "Your receipt from GitHub", "Total: $4.00"),
      // Single receipt-like email — below minReceiptLike.
      entry("orders@shop.example", "Order confirmation", "Total: $9.99"),
    ];
    const { scanned, candidates } = await inferRuleCandidates("tok", OWNER);
    expect(scanned).toBe(8);
    expect(candidates.map((c) => c.sender)).toEqual([
      "email.apple.com",
      "stripe.com",
    ]);
    const apple = candidates[0]!;
    expect(apple).toMatchObject({ total: 2, receiptLike: 2, ratio: 1 });
  });

  it("never recommends freemail domains or the owner's own domain", async () => {
    jmap.state.entries = [
      entry("friend@gmail.com", "Your receipt from dinner", "Total: $20.00"),
      entry("friend@gmail.com", "Re: your invoice", "Total: $5.00"),
      entry("me@example.com", "Your order", "Total: $1.00"),
      entry("me@example.com", "Your receipt", "Total: $2.00"),
    ];
    const { candidates } = await inferRuleCandidates("tok", OWNER);
    expect(candidates).toEqual([]);
  });

  it("returns nothing on an empty inbox", async () => {
    const result = await inferRuleCandidates("tok", OWNER);
    expect(result).toEqual({ scanned: 0, candidates: [] });
  });

  it("uses preview text as the body signal", async () => {
    jmap.state.entries = [
      entry("billing@saas.example", "Your subscription", "Order total: $49.00"),
      entry("billing@saas.example", "Your subscription", "Order total: $49.00"),
    ];
    const { candidates } = await inferRuleCandidates("tok", OWNER);
    expect(candidates.map((c) => c.sender)).toEqual(["saas.example"]);
  });
});

describe("apply path (addEmailRule as inferred general rule)", () => {
  beforeEach(async () => {
    await testPrisma.emailRule.deleteMany({ where: { source: "inferred" } });
  });

  it("adds inferred rules as general rules, idempotently", async () => {
    await addEmailRule({
      accountId: "",
      sender: "acme-shop.example",
      source: "inferred",
    });
    await addEmailRule({
      accountId: "",
      sender: "acme-shop.example",
      source: "inferred",
    });
    const general = await listGeneralEmailRules();
    // A sender NOT in the seed (stripe.com is) — source must stay "inferred".
    expect(
      general.filter((r) => r.sender === "acme-shop.example"),
    ).toHaveLength(1);
    expect(general.find((r) => r.sender === "acme-shop.example")).toMatchObject(
      {
        accountId: "",
        source: "inferred",
      },
    );
  });

  it("does not collide with a user rule of the same sender", async () => {
    await addEmailRule({
      accountId: "",
      sender: "acme.com",
      source: "inferred",
    });
    const userRule = await addEmailRule({
      accountId: TEST_ACCOUNT_ID,
      sender: "acme.com",
      source: "forward",
    });
    expect(userRule.ok).toBe(true);
  });
});
