import { expect } from "playwright/test";
import { describe, it } from "vitest";
import {
  fetchPublicUrl,
  isPrivateHost,
  isPrivateUrl,
  readBodyLimited,
} from "~/lib/ssrf.server";

/**
 * SSRF guard tests: private/reserved hosts are rejected by name and by
 * resolved address, non-http(s) schemes are rejected, unresolvable hosts
 * fail closed, and redirects are re-checked at every hop.
 */

const PRIVATE_HOSTS = [
  "localhost",
  "localhost.localdomain",
  "127.0.0.1",
  "10.0.0.1",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.1",
  "169.254.169.254",
  "0.0.0.0",
  "255.255.255.255",
  "fe80::1",
  "fd00::1",
  "fc00::",
  "::1",
  "[::1]",
  "0:0:0:0:0:0:0:1",
  "::",
  "ff02::1",
  "::ffff:127.0.0.1",
  "::ffff:10.0.0.1",
  // IPv4-mapped IPv6 in hex / full form: the same private addresses
  // spelled differently (regression: these bypassed the old regex guard).
  "::ffff:a00:1",
  "[::ffff:c0a8:101]",
  "0:0:0:0:0:ffff:7f00:1",
  "::ffff:ac10:1",
];

const PUBLIC_HOSTS = [
  "example.com",
  "fcc.gov", // regression: the old fc/fd prefix check blocked real hosts
  "fdic.gov",
  "8.8.8.8",
  "93.184.216.34",
  "2001:4860:4860::8888",
  "::ffff:8.8.8.8", // mapped to a PUBLIC v4 address must stay allowed
];

describe("isPrivateHost", () => {
  it("rejects loopback, private, link-local, and reserved hosts", () => {
    for (const host of PRIVATE_HOSTS) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it("allows public hosts", () => {
    for (const host of PUBLIC_HOSTS) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });
});

describe("isPrivateUrl", () => {
  it("rejects non-http(s) schemes", async () => {
    for (const url of [
      "ftp://example.com/a.png",
      "file:///etc/passwd",
      "data:text/html,<script>",
    ]) {
      expect(await isPrivateUrl(new URL(url)), url).toBe(true);
    }
  });

  it("rejects a public hostname that resolves to a private address", async () => {
    const resolvePrivate = async () => [{ address: "10.1.2.3", family: 4 }];
    expect(
      await isPrivateUrl(
        new URL("https://evil.example/receipt.png"),
        resolvePrivate as never,
      ),
    ).toBe(true);
  });

  it("allows a hostname that resolves to public addresses", async () => {
    const resolvePublic = async () => [{ address: "93.184.216.34", family: 4 }];
    expect(
      await isPrivateUrl(
        new URL("https://example.com/receipt.png"),
        resolvePublic as never,
      ),
    ).toBe(false);
  });

  it("fails closed on unresolvable hostnames", async () => {
    const unresolvable = async () => {
      throw new Error("ENOTFOUND no-such-host.invalid");
    };
    expect(
      await isPrivateUrl(
        new URL("https://no-such-host.invalid/x"),
        unresolvable as never,
      ),
    ).toBe(true);
  });
});

describe("fetchPublicUrl", () => {
  it("rejects private URLs before any network call", async () => {
    await expect(fetchPublicUrl("http://127.0.0.1/a.png")).rejects.toThrow(
      "Blocked: private or unresolvable host",
    );
    await expect(
      fetchPublicUrl("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow("Blocked: private or unresolvable host");
    await expect(fetchPublicUrl("http://localhost:8080/a.png")).rejects.toThrow(
      "Blocked: private or unresolvable host",
    );
  });

  it("rejects invalid URLs and non-http(s) schemes", async () => {
    await expect(fetchPublicUrl("not a url")).rejects.toThrow("Invalid URL");
    await expect(fetchPublicUrl("file:///etc/passwd")).rejects.toThrow(
      "Blocked: private or unresolvable host",
    );
    await expect(fetchPublicUrl("ftp://example.com/a.png")).rejects.toThrow(
      "Blocked: private or unresolvable host",
    );
  });

  it("re-checks the target at every redirect hop", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.startsWith("https://public.example/receipt.png")) {
        // Public first hop redirects into a private address; must block.
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/receipt.png" },
        });
      }
      return originalFetch(input);
    }) as typeof fetch;
    const resolvePublic = async () => [{ address: "93.184.216.34", family: 4 }];
    try {
      await expect(
        fetchPublicUrl(
          "https://public.example/receipt.png",
          { redirects: 3 },
          resolvePublic as never,
        ),
      ).rejects.toThrow("Blocked: private or unresolvable host");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("readBodyLimited", () => {
  it("returns the full body when within the cap", async () => {
    const res = new Response("hello world");
    expect((await readBodyLimited(res, 100)).toString()).toBe("hello world");
  });

  it("returns an empty body when the response has none", async () => {
    expect(await readBodyLimited(new Response(null), 100)).toHaveLength(0);
  });

  it("throws mid-stream once the cap is exceeded", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
        controller.enqueue(new Uint8Array([6, 7, 8, 9, 10]));
        controller.close();
      },
    });
    const res = new Response(stream);
    await expect(readBodyLimited(res, 7)).rejects.toThrow("Response too large");
  });
});
