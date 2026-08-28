import type { LLMError as LlmError } from "~/lib/receipt-ai.server";
import type { SendEmailInput } from "~/lib/email-mime.server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The alert is fire-and-forget inside receipt-ai; mock the transport and
// the owner address to test the gating logic in isolation.
const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn((input: SendEmailInput) => {
    void input;
    return Promise.resolve(true);
  }),
}));

vi.mock("~/lib/reply.server", () => ({
  sendEmail: mocks.sendEmail,
}));

// The dynamic imports below are the point of these tests: the dedupe
// state is a module-level singleton in receipt-ai, and vi.resetModules +
// re-import is how the tests reset it between cases (a static import
// would also defeat the instanceof check against the re-registered
// LLMError class).
describe("maybeAlertLlmUnusable", () => {
  let maybeAlertLlmUnusable: (err: unknown, now?: number) => void;
  let llmErrorCtor: new (
    message: string,
    status: number,
    body: string,
  ) => LlmError;
  // Runtime binding for the re-imported module's class (the type import
  // above is erased; this is the value the instanceof check uses).
  let LLMError: new (message: string, status: number, body: string) => LlmError;
  const OWNER = "assaf@labnotes.org";
  const llmError = (status: number) =>
    new llmErrorCtor(`DeepSeek API ${status}: test failure`, status, "");

  beforeEach(async () => {
    vi.resetModules();
    process.env.APP_EMAIL = OWNER;
    ({ maybeAlertLlmUnusable, LLMError } =
      await import("~/lib/receipt-ai.server"));
    llmErrorCtor = LLMError;
    mocks.sendEmail.mockClear();
  });

  it("alerts on 402 (insufficient balance)", () => {
    maybeAlertLlmUnusable(llmError(402), Date.now());
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const input = mocks.sendEmail.mock.calls[0][0];
    expect(input.to).toBe(OWNER);
    expect(input.subject).toContain("receipt AI is unavailable");
    expect(input.text).toContain("insufficient balance");
  });

  it("alerts on 401 (invalid or revoked key)", () => {
    maybeAlertLlmUnusable(llmError(401), Date.now());
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });
  it("escapes the provider error body before it reaches the email HTML", () => {
    const hostile = 'DeepSeek API 401: <img src=x onerror="alert(1)">';
    maybeAlertLlmUnusable(new llmErrorCtor(hostile, 401, ""), Date.now());
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const input = mocks.sendEmail.mock.calls[0][0];
    expect(input.html).toContain("&lt;img src=x");
    expect(input.html).not.toContain("<img src=x");
  });

  it("does not alert on transient failures (502 empty content, 429, 500)", () => {
    maybeAlertLlmUnusable(llmError(502), Date.now());
    maybeAlertLlmUnusable(llmError(429), Date.now() + 1);
    maybeAlertLlmUnusable(llmError(500), Date.now() + 2);
    maybeAlertLlmUnusable(new Error("regular error"), 1003);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("dedupes to one email per 24h", () => {
    maybeAlertLlmUnusable(llmError(402), Date.now());
    maybeAlertLlmUnusable(llmError(402), Date.now() + 3600_000);
    maybeAlertLlmUnusable(llmError(402), Date.now() + 23 * 3600_000);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    maybeAlertLlmUnusable(llmError(402), Date.now() + 25 * 3600_000);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
  });

  it("skips when no owner address is configured", async () => {
    vi.resetModules();
    delete process.env.APP_EMAIL;
    ({ maybeAlertLlmUnusable } = await import("~/lib/receipt-ai.server"));
    maybeAlertLlmUnusable(llmError(402), Date.now());
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});
