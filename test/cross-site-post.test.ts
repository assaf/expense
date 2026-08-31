import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * rejectCrossSitePost: the app-level login-CSRF guard. Strict origin
 * equality passes, no-Origin requests pass (no ambient cookies), and a
 * foreign origin is rejected with 403. Behind a TLS-terminating proxy
 * (https://expense.localhost -> http://127.0.0.1) the scheme and Host the
 * server sees differ from the browser's Origin, so same-host matching via
 * x-forwarded-host must be accepted too.
 */

import { rejectCrossSitePost } from "~/lib/auth.server";

function post(headers: Record<string, string>): Request {
  return new Request("http://127.0.0.1:4582/login", {
    method: "POST",
    headers,
    body: new FormData(),
  });
}

function expectBlocked(request: Request) {
  let thrown: unknown;
  try {
    rejectCrossSitePost(request);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Response);
  expect((thrown as Response).status).toBe(403);
}

describe("rejectCrossSitePost", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes when the Origin matches the request origin exactly", () => {
    expect(() =>
      rejectCrossSitePost(post({ Origin: "http://127.0.0.1:4582" })),
    ).not.toThrow();
  });

  it("passes requests without an Origin header", () => {
    expect(() => rejectCrossSitePost(post({}))).not.toThrow();
  });

  it("blocks a foreign origin", () => {
    expectBlocked(post({ Origin: "https://evil.example" }));
  });

  it("blocks an unparseable Origin", () => {
    expectBlocked(post({ Origin: "not a url" }));
  });

  it("accepts the proxied browser origin via x-forwarded-host", () => {
    expect(() =>
      rejectCrossSitePost(
        post({
          Origin: "https://expense.localhost",
          "X-Forwarded-Host": "expense.localhost",
          "X-Forwarded-Proto": "https",
        }),
      ),
    ).not.toThrow();
  });

  it("still blocks a foreign origin even when a proxy is in the chain", () => {
    expectBlocked(
      post({
        Origin: "https://evil.example",
        "X-Forwarded-Host": "expense.localhost",
        "X-Forwarded-Proto": "https",
      }),
    );
  });
});
