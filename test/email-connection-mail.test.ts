import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { learnAuthservId } from "~/lib/email-connection-mail.server";

/**
 * The delivery stamp a generic JMAP connection trusts, learned from the
 * newest Authentication-Results header in the mailbox.
 *
 * Two facts have to stay apart: a mailbox with nothing to teach us is a
 * wait (the drain skips the connection), and a provider we cannot read is a
 * failure (the drain reports it). They used to look alike, so a mail server
 * answering HTTP 502 was reported as a mailbox that had not received mail
 * yet, on every push, and the reason never reached the owner (EXPENSE-1Q).
 *
 * The JMAP layer is stubbed rather than fetched: the session URL goes
 * through the SSRF guard, which blocks a host that does not resolve.
 */

const jmap = vi.hoisted(() => ({
  tryMailboxIdByRole: vi.fn(
    async (_server: unknown, _role: string) => "inbox-1" as string | undefined,
  ),
  jmapCall: vi.fn(
    async (
      _server: unknown,
      _calls: unknown[][],
    ): Promise<[string, unknown, string][]> => [],
  ),
}));

vi.mock("~/lib/jmap.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/jmap.server")>();
  return {
    ...actual,
    tryMailboxIdByRole: jmap.tryMailboxIdByRole,
    jmapCall: jmap.jmapCall,
  };
});

const server = {
  sessionUrl: "https://mail.example.test/.well-known/jmap",
  authorization: "Bearer tok-1",
};

/** The method the stubbed call is answering, so one fake can serve the
 * query and the get. */
function methodOf(calls: unknown[][]): string {
  return (calls[0]?.[0] as string) ?? "";
}

/** Answer the two calls the lookup makes: the query for the newest
 * messages, then the headers of those messages. */
function stubMailbox(options: { ids?: string[]; headers?: string[][] }) {
  jmap.jmapCall.mockImplementation(async (_server, calls) => {
    const method = methodOf(calls);
    if (method === "Email/query") {
      return [["Email/query", { ids: options.ids ?? [] }, "m0"]];
    }
    return [
      [
        "Email/get",
        {
          list: (options.headers ?? []).map((values) => ({
            "header:Authentication-Results:asText": values,
          })),
        },
        "m0",
      ],
    ];
  });
}

describe("learnAuthservId", () => {
  beforeEach(() => {
    jmap.tryMailboxIdByRole.mockReset();
    jmap.tryMailboxIdByRole.mockResolvedValue("inbox-1");
    jmap.jmapCall.mockReset();
  });

  it("learns the stamp from the newest stamped message", async () => {
    stubMailbox({
      ids: ["e1", "e2"],
      headers: [
        ["mx.example.com; dkim=pass header.i=@example.com"],
        ["other.example.net; spf=pass"],
      ],
    });

    expect(await learnAuthservId(server, "acct-1")).toBe("mx.example.com");
  });

  it("answers nothing to learn when the mailbox holds no mail", async () => {
    stubMailbox({ ids: [] });

    expect(await learnAuthservId(server, "acct-1")).toBeUndefined();
  });

  it("answers nothing to learn when no message carries a stamp", async () => {
    stubMailbox({ ids: ["e1"], headers: [[]] });

    expect(await learnAuthservId(server, "acct-1")).toBeUndefined();
  });

  it("throws when the provider cannot be read, instead of looking empty", async () => {
    // The whole point of the change: a provider that answers 502 is a
    // failure the drain has to report, not a mailbox with nothing to teach
    // it. Answering undefined here is what made a broken mail server look
    // like a quiet one, and the drain said "no stamp yet" on every push.
    jmap.jmapCall.mockRejectedValue(
      new Error("That server answered HTTP 502."),
    );

    await expect(learnAuthservId(server, "acct-1")).rejects.toThrow(/HTTP 502/);
  });

  it("throws when the mailbox cannot be listed", async () => {
    jmap.tryMailboxIdByRole.mockRejectedValue(
      new Error("Blocked: private or unresolvable host"),
    );

    await expect(learnAuthservId(server, "acct-1")).rejects.toThrow(/Blocked/);
  });
});
