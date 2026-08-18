import { describe, expect, it, vi } from "vitest";
import {
  sendEmailViaJmap,
  type FastmailIdentity,
  type JmapSendDeps,
} from "~/lib/fastmail.server";

/**
 * sendEmailViaJmap with injected deps — exercises the whole
 * identity-match → build MIME → upload → import → submit sequence offline
 * (outbound network is blocked in tests).
 */

const RECEIPTS = "receipts@labnotes.org";

function identity(overrides: Partial<FastmailIdentity> = {}): FastmailIdentity {
  return {
    id: "id-1",
    name: "Expense",
    email: RECEIPTS,
    saveSentToMailboxId: "sent-1",
    ...overrides,
  };
}

function fakes(
  identities: FastmailIdentity[],
  overrides: Partial<JmapSendDeps> = {},
): {
  deps: JmapSendDeps;
  uploadBlob: ReturnType<typeof vi.fn>;
  importEmail: ReturnType<typeof vi.fn>;
  submitEmail: ReturnType<typeof vi.fn>;
} {
  const uploadBlob = vi.fn(async (_raw: Buffer) => "blob-1");
  const importEmail = vi.fn(
    async (_blobId: string, _mailboxId: string) => "email-1",
  );
  const submitEmail = vi.fn(
    async (_identityId: string, _emailId: string) => {},
  );
  return {
    deps: {
      listIdentities: vi.fn(async () => identities),
      uploadBlob,
      importEmail,
      submitEmail,
      fromAddress: RECEIPTS,
      ...overrides,
    },
    uploadBlob,
    importEmail,
    submitEmail,
  };
}

const input = {
  to: "assaf@arkin.me",
  subject: "Your receipt was added",
  html: "<p>done</p>",
};

describe("sendEmailViaJmap", () => {
  it("picks the exact identity match and runs upload → import → submit", async () => {
    const { deps, uploadBlob, importEmail, submitEmail } = fakes([
      identity({ id: "wild", email: "*@labnotes.org" }),
      identity({
        id: "exact",
        email: RECEIPTS,
        saveSentToMailboxId: "sent-exact",
      }),
    ]);

    const ok = await sendEmailViaJmap(input, deps);

    expect(ok).toBe(true);
    // Exact match beats wildcard.
    expect(importEmail).toHaveBeenCalledWith("blob-1", "sent-exact");
    expect(submitEmail).toHaveBeenCalledWith("exact", "email-1");
    // The uploaded raw is the built RFC 5322 message.
    const raw = uploadBlob.mock.calls[0]![0] as Buffer;
    expect(raw.toString("utf8")).toContain("Subject: Your receipt was added");
    expect(raw.toString("utf8")).toContain("To: assaf@arkin.me");
    // upload happens before import, import before submit.
    expect(uploadBlob.mock.invocationCallOrder[0]).toBeLessThan(
      importEmail.mock.invocationCallOrder[0]!,
    );
    expect(importEmail.mock.invocationCallOrder[0]).toBeLessThan(
      submitEmail.mock.invocationCallOrder[0]!,
    );
  });

  it("falls back to a wildcard identity for an unmatched address", async () => {
    const { deps, importEmail } = fakes(
      [identity({ id: "wild", email: "*@labnotes.org" })],
      { fromAddress: "anything@labnotes.org" },
    );

    expect(await sendEmailViaJmap(input, deps)).toBe(true);
    expect(importEmail).toHaveBeenCalledWith("blob-1", "sent-1");
  });

  it("falls back to the first identity when nothing matches", async () => {
    const { deps, importEmail } = fakes(
      [
        identity({ id: "first", email: "a@x.com" }),
        identity({ id: "second", email: "b@x.com" }),
      ],
      { fromAddress: "nobody@nowhere.invalid" },
    );

    expect(await sendEmailViaJmap(input, deps)).toBe(true);
    expect(importEmail).toHaveBeenCalledWith("blob-1", "sent-1");
  });

  it("uses the first identity when no from address is configured", async () => {
    const { deps, importEmail } = fakes(
      [identity({ id: "first" }), identity({ id: "second" })],
      { fromAddress: "" },
    );

    expect(await sendEmailViaJmap(input, deps)).toBe(true);
    expect(importEmail).toHaveBeenCalledWith("blob-1", "sent-1");
  });

  it("passes attachments and In-Reply-To through to the message", async () => {
    const { deps, uploadBlob } = fakes([identity()]);
    await sendEmailViaJmap(
      {
        ...input,
        inReplyTo: "<orig@fastmail.test>",
        attachments: [{ content: "aGVsbG8=", filename: "receipt.png" }],
      },
      deps,
    );

    const raw = (uploadBlob.mock.calls[0]![0] as Buffer).toString("utf8");
    expect(raw).toContain("In-Reply-To: <orig@fastmail.test>");
    expect(raw).toContain('filename="receipt.png"');
  });

  it("returns false (not throw) when both submit attempts fail", async () => {
    const submitEmail = vi.fn(async () => {
      throw new Error("boom");
    });
    const { deps } = fakes([identity()], { submitEmail });

    expect(await sendEmailViaJmap(input, deps)).toBe(false);
    // The transient-failure retry runs once, then gives up.
    expect(submitEmail).toHaveBeenCalledTimes(2);
  });

  it("retries the submission once with the same email id", async () => {
    const submitEmail = vi
      .fn()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce(undefined);
    const { deps, uploadBlob, importEmail } = fakes([identity()], {
      submitEmail,
    });

    expect(await sendEmailViaJmap(input, deps)).toBe(true);
    expect(submitEmail).toHaveBeenCalledTimes(2);
    // The retry reuses the same email id — the blob upload and Sent import
    // already succeeded, so only the submission repeats.
    expect(submitEmail).toHaveBeenNthCalledWith(1, "id-1", "email-1");
    expect(submitEmail).toHaveBeenNthCalledWith(2, "id-1", "email-1");
    expect(uploadBlob).toHaveBeenCalledTimes(1);
    expect(importEmail).toHaveBeenCalledTimes(1);
  });

  it("returns false when there are no identities", async () => {
    const { deps } = fakes([]);
    expect(await sendEmailViaJmap(input, deps)).toBe(false);
  });

  it("returns false when listIdentities throws", async () => {
    const { deps } = fakes([], {
      listIdentities: vi.fn(async () => {
        throw new Error("jmap down");
      }),
    });
    expect(await sendEmailViaJmap(input, deps)).toBe(false);
  });
});
