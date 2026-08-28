import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToUsd, usdRate } from "~/lib/fx.server";

/**
 * Foreign-currency → USD conversion. The Frankfurter fetch is stubbed (the
 * unit project blocks live network via env.ts's fetch wrapper), so these
 * pin both the rate-API contract and the conversion math the IRS
 * payment-date rule relies on: the response's `date` reports the day the
 * rate is actually for (weekends roll back to the previous business day),
 * a 404 means "no rate exists yet" (future dates, unsupported currencies),
 * and amounts round half-up to cents like the app's other money math.
 */

function frankfurterBody(date: string, usd: number): string {
  return JSON.stringify({
    amount: 1.0,
    base: "EUR",
    date,
    rates: { USD: usd },
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(frankfurterBody("2026-03-13", 1.1476), { status: 200 }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("convertToUsd math", () => {
  const rate = async () => ({ rate: "1.1476", rateDate: "2026-03-13" });

  it("multiplies and rounds half-up to cents, reporting the conversion", async () => {
    const fx = await convertToUsd("50.00", "EUR", "2026-03-14", {
      fetchRate: rate,
    });
    expect(fx).toEqual({
      currency: "EUR",
      originalAmount: "50.00",
      amount: "57.38",
      fxRate: "1.1476",
      rateDate: "2026-03-13",
    });
  });

  it("keeps sub-cent rates exact for large amounts (JPY-style)", async () => {
    const fx = await convertToUsd("15000", "JPY", "2026-03-14", {
      fetchRate: async () => ({ rate: "0.00627", rateDate: "2026-03-14" }),
    });
    expect(fx?.amount).toBe("94.05");
  });

  it("rounds a half-cent up", async () => {
    const fx = await convertToUsd("10.00", "EUR", "2026-03-14", {
      fetchRate: async () => ({ rate: "0.0067", rateDate: "2026-03-14" }),
    });
    expect(fx?.amount).toBe("0.07");
  });

  it("normalizes a lowercase currency code", async () => {
    const fx = await convertToUsd("50", "eur", "2026-03-14", {
      fetchRate: rate,
    });
    expect(fx?.currency).toBe("EUR");
  });

  it("returns null for USD, unknown codes, junk amounts, and empty dates", async () => {
    const fetchRate = vi.fn(rate);
    expect(
      await convertToUsd("50.00", "USD", "2026-03-14", { fetchRate }),
    ).toBeNull();
    expect(
      await convertToUsd("50.00", "EU", "2026-03-14", { fetchRate }),
    ).toBeNull();
    expect(
      await convertToUsd("", "EUR", "2026-03-14", { fetchRate }),
    ).toBeNull();
    expect(
      await convertToUsd("not-a-number", "EUR", "2026-03-14", { fetchRate }),
    ).toBeNull();
    expect(
      await convertToUsd("0", "EUR", "2026-03-14", { fetchRate }),
    ).toBeNull();
    // Nothing above needed a rate, so no lookup may have happened.
    expect(fetchRate).not.toHaveBeenCalled();
  });

  it("returns null when no rate is available", async () => {
    const fx = await convertToUsd("50.00", "EUR", "2026-03-14", {
      fetchRate: async () => null,
    });
    expect(fx).toBeNull();
  });
});

describe("usdRate against the Frankfurter API", () => {
  it("reads the rate and the as-of date from a single-date query", async () => {
    const fx = await usdRate("EUR", "2026-03-14");
    // Saturday 2026-03-14: the response reports Friday's rate.
    expect(fx).toEqual({ rate: "1.1476", rateDate: "2026-03-13" });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.frankfurter.dev/v1/2026-03-14?base=EUR&symbols=USD",
      expect.anything(),
    );
  });

  it("returns null for a bad currency or date without fetching", async () => {
    expect(await usdRate("EURO", "2026-03-14")).toBeNull();
    expect(await usdRate("EUR", "2026-3-14")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns null on a 404 (future date or unsupported currency)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response('{"message":"not found"}', { status: 404 }),
      ),
    );
    expect(await usdRate("EUR", "2027-01-01")).toBeNull();
  });

  it("returns null on a malformed body instead of inventing a rate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    expect(await usdRate("EUR", "2026-03-13")).toBeNull();
  });

  it("caches a successful lookup per (currency, date), coalescing repeats", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(frankfurterBody("2026-03-13", 1.1476), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const [first, second] = await Promise.all([
      usdRate("GBP", "2026-03-13"),
      usdRate("GBP", "2026-03-13"),
    ]);
    expect(first).toEqual({ rate: "1.1476", rateDate: "2026-03-13" });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A different date is a different immutable fact: fetched separately.
    await usdRate("GBP", "2026-03-12");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure, so the next capture retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(frankfurterBody("2026-03-13", 1.1476), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    expect(await usdRate("CHF", "2026-03-13")).toBeNull();
    expect(await usdRate("CHF", "2026-03-13")).toEqual({
      rate: "1.1476",
      rateDate: "2026-03-13",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
