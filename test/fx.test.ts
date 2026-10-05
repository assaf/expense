import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { convertToUsd, usdRate } from "~/lib/fx.server";
import {
  conversionNote,
  formatFxRate,
  readConversionNote,
  withConversionNote,
  type ConversionNoteFields,
} from "~/lib/fx-note";
import fc from "fast-check";
import { assertProperty, text } from "./helpers/property";

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

describe("conversion description note", () => {
  it("formats the applied conversion with rate and as-of date", () => {
    expect(
      conversionNote({
        currency: "EUR",
        originalAmount: "50.00",
        fxRate: "1.1699",
        rateDate: "2026-08-21",
      }),
    ).toBe(
      "(Converted from EUR 50.00 at 1.1699 USD/EUR, ECB rate for 2026-08-21.)",
    );
  });

  it("omits the as-of date when unknown and covers the no-rate case", () => {
    expect(
      conversionNote({
        currency: "EUR",
        originalAmount: "50.00",
        fxRate: "1.1699",
        rateDate: "",
      }),
    ).toBe("(Converted from EUR 50.00 at 1.1699 USD/EUR.)");
    expect(
      conversionNote({
        currency: "JPY",
        originalAmount: "15000.00",
        fxRate: "",
        rateDate: "",
      }),
    ).toBe("(Amount is in JPY; no exchange rate was available, stored as-is.)");

    expect(
      conversionNote({
        currency: "USD",
        originalAmount: "",
        fxRate: "",
        rateDate: "",
      }),
    ).toBe("");
  });

  it("trims the numeric(10,6) wire precision from the rate", () => {
    expect(
      conversionNote({
        currency: "EUR",
        originalAmount: "50.00",
        fxRate: "1.169900",
        rateDate: "2026-08-21",
      }),
    ).toBe(
      "(Converted from EUR 50.00 at 1.1699 USD/EUR, ECB rate for 2026-08-21.)",
    );
    // And a re-save over the 6dp note normalizes it instead of stacking.
    expect(
      withConversionNote(
        "Team lunch (Converted from EUR 50.00 at 1.169900 USD/EUR, ECB rate for 2026-08-21.)",
        {
          currency: "EUR",
          originalAmount: "50.00",
          fxRate: "1.169900",
          rateDate: "2026-08-21",
        },
      ),
    ).toBe(
      "Team lunch (Converted from EUR 50.00 at 1.1699 USD/EUR, ECB rate for 2026-08-21.)",
    );
  });

  it("appends to user text and is idempotent across re-saves", () => {
    const fx = {
      currency: "EUR",
      originalAmount: "50.00",
      fxRate: "1.1699",
      rateDate: "2026-08-21",
    };
    const once = withConversionNote("Team lunch in Paris", fx);
    expect(once).toBe(
      "Team lunch in Paris (Converted from EUR 50.00 at 1.1699 USD/EUR, ECB rate for 2026-08-21.)",
    );
    expect(withConversionNote(once, fx)).toBe(once);
    expect(withConversionNote("", fx)).toBe(
      once.replace("Team lunch in Paris ", ""),
    );
  });

  it("replaces the note in place when a re-convert changes the rate", () => {
    const before = withConversionNote("Team lunch", {
      currency: "EUR",
      originalAmount: "50.00",
      fxRate: "1.1645",
      rateDate: "2026-08-27",
    });
    const after = withConversionNote(before, {
      currency: "EUR",
      originalAmount: "50.00",
      fxRate: "1.1699",
      rateDate: "2026-08-21",
    });
    expect(after).toBe(
      "Team lunch (Converted from EUR 50.00 at 1.1699 USD/EUR, ECB rate for 2026-08-21.)",
    );
  });

  it("clears a stale note when the receipt turns out to be USD, and keeps stored-as-is wording", () => {
    const foreign = withConversionNote("Coffee", {
      currency: "EUR",
      originalAmount: "4.50",
      fxRate: "1.1645",
      rateDate: "2026-08-27",
    });
    expect(
      withConversionNote(foreign, {
        currency: "USD",
        originalAmount: "",
        fxRate: "",
        rateDate: "",
      }),
    ).toBe("Coffee");
    expect(
      withConversionNote("Coffee", {
        currency: "GBP",
        originalAmount: "3.20",
        fxRate: "",
        rateDate: "",
      }),
    ).toBe(
      "Coffee (Amount is in GBP; no exchange rate was available, stored as-is.)",
    );
  });

  it("reads the rate and as-of date back out of a stored description", () => {
    expect(
      readConversionNote(
        "Team lunch (Converted from EUR 50.00 at 1.1699 USD/EUR, ECB rate for 2026-08-21.)",
      ),
    ).toEqual({ fxRate: "1.1699", rateDate: "2026-08-21" });
    expect(
      readConversionNote("Trip (Converted from EUR 50.00 at 1.1699 USD/EUR.)"),
    ).toEqual({ fxRate: "1.1699", rateDate: "" });
    expect(readConversionNote("No note here")).toBeNull();
    expect(
      readConversionNote(
        "Coffee (Amount is in GBP; no exchange rate was available, stored as-is.)",
      ),
    ).toBeNull();
  });
});

/**
 * `app/lib/fx-note.ts` keeps one note shape in three places: the two
 * templates in `conversionNote` and the `NOTE_RE` that strips it on a re-save.
 * A formatting change to one that misses the others desynchronises them
 * silently, which is exactly what the strip-then-append property below
 * catches.
 */

/** The provenance quad for a captured receipt, non-USD so a note is
 * produced at all. */
const fxFields = fc.record({
  currency: fc.constantFrom(
    "EUR",
    "GBP",
    "JPY",
    "CHF",
    "CAD",
    "AUD",
    "SEK",
    "NOK",
  ),
  originalAmount: fc.stringMatching(/^\d+(\.\d{1,2})?$/),
  fxRate: fc.stringMatching(/^\d+(\.\d{1,6})?$/),
  rateDate: fc.constantFrom("", "2026-08-01", "2026-08-03"),
});

/** A converted receipt, for the case that is a table over one field. */
const CONVERTED: ConversionNoteFields = {
  currency: "EUR",
  originalAmount: "50.00",
  fxRate: "1.1699",
  rateDate: "2026-08-21",
};

/** The description the note is appended to. */
const description = text(40);

describe("app/lib/fx-note.ts properties", () => {
  it("replaces the note instead of stacking copies", () => {
    // The inner result is `base(d) + " " + note(fx1)` and NOTE_RE removes
    // exactly that note before trimming, so the outer call is the only one
    // that survives.
    assertProperty([description, fxFields, fxFields], (d, fx1, fx2) => {
      expect(withConversionNote(withConversionNote(d, fx1), fx2)).toBe(
        withConversionNote(d, fx2),
      );
    });
  });

  it("reads back the formatted rate it stored", () => {
    assertProperty([fxFields], (fx) => {
      const read = readConversionNote(withConversionNote("", fx));
      expect(read).toEqual({
        fxRate: formatFxRate(fx.fxRate),
        rateDate: fx.rateDate,
      });
    });
  });

  it("writes no note for USD or a malformed currency", () => {
    // Only `/^[A-Z]{3}$/` and not "USD" produce a note, so everything else
    // is stored undocumented. A table, not a property: the outcome does not
    // depend on any generated field.
    for (const currency of ["USD", "usd", "EU", "EU1", "", "EUROP", "€"]) {
      expect(conversionNote({ ...CONVERTED, currency })).toBe("");
    }
  });

  it("formats a rate idempotently, never leaving a bare point", () => {
    assertProperty([fc.stringMatching(/^\d*(\.\d*)?$/)], (r) => {
      const once = formatFxRate(r);
      expect(formatFxRate(once)).toBe(once);
      expect(once.endsWith(".")).toBe(false);
    });
  });

  it("never throws over generated provenance and description", () => {
    assertProperty([description, fxFields], (d, fx) => {
      expect(() => withConversionNote(d, fx)).not.toThrow();
      expect(() => readConversionNote(d)).not.toThrow();
    });
  });
});
