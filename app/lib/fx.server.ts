import Decimal from "decimal.js";
import { parseAmount } from "~/lib/money";

/**
 * Foreign-currency → USD conversion at the exchange rate for the expense's
 * date: the IRS "rate prevailing when you paid" rule (Pub. 525 / the IRS
 * currency-exchange-rate guidance). Rates come from Frankfurter
 * (api.frankfurter.dev), a no-key mirror of the ECB's daily reference feed,
 * the same free-no-auth pattern as the maps stack (Nominatim/OSRM):
 *
 * - A weekend/holiday date rolls back to the previous business day's rate
 *   automatically (the response's `date` field reports the day actually
 *   used, so the caller can say which rate applied).
 * - A future date (or a currency the ECB doesn't publish) is a 404, i.e.
 *   "no rate exists yet": callers keep the receipt's amount as-is rather
 *   than inventing a conversion.
 *
 * Successful (currency, date) lookups are cached per process — rates are
 * immutable history, so a cache hit is always correct. Failures are not
 * cached: the next receipt retries, and a Frankfurter outage degrades to
 * "stored as-is" instead of blocking captures.
 */

/** The ECB publishes ~30 currencies; anything else (and any network or
 * parse failure) returns null and the receipt is stored unconverted. */
const FRANKFURTER_BASE_URL = "https://api.frankfurter.dev/v1";
const FETCH_TIMEOUT_MS = 5000;

export interface FxConversion {
  /** ISO 4217 code of the receipt's currency (uppercased). */
  currency: string;
  /** The receipt's printed amount in `currency`, 2 decimals. */
  originalAmount: string;
  /** The converted USD amount (what the expense stores as `amount`), 2
   * decimals, rounded half-up like every other money math in the app. */
  amount: string;
  /** USD per 1 unit of `currency`, as used (the API's precision). */
  fxRate: string;
  /** YYYY-MM-DD the reference rate is for; a weekend purchase gets the
   * previous business day's rate. */
  rateDate: string;
}

export interface FxRate {
  /** USD per 1 unit of the currency, as a decimal string. */
  rate: string;
  /** YYYY-MM-DD the rate is actually for (≤ the requested date). */
  rateDate: string;
}

function isValidCurrencyCode(currency: string): boolean {
  return /^[A-Z]{3}$/.test(currency);
}

function isValidDateString(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

/** The USD rate for (currency, date), or null when unavailable. */
export async function usdRate(
  currency: string,
  date: string,
  fetcher: typeof fetch = fetch,
): Promise<FxRate | null> {
  if (!isValidCurrencyCode(currency) || !isValidDateString(date)) return null;
  const cacheKey = `${currency}:${date}`;
  const cached = rateCache.get(cacheKey);
  if (cached) return cached;
  const inFlight = inFlightLookups.get(cacheKey);
  if (inFlight) return inFlight;

  const lookup = (async () => {
    try {
      const res = await fetcher(
        `${FRANKFURTER_BASE_URL}/${date}?base=${currency}&symbols=USD`,
        { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as {
        date?: string;
        rates?: { USD?: number };
      };
      const rate = body.rates?.USD;
      // ECB rates carry 4-6 significant digits (JPY is ~0.006), so the
      // JSON number survives a plain string round-trip exactly.
      if (
        typeof rate !== "number" ||
        !Number.isFinite(rate) ||
        rate <= 0 ||
        typeof body.date !== "string" ||
        !isValidDateString(body.date)
      ) {
        return null;
      }
      const found: FxRate = { rate: String(rate), rateDate: body.date };
      rateCache.set(cacheKey, found);
      return found;
    } catch {
      return null;
    } finally {
      inFlightLookups.delete(cacheKey);
    }
  })();
  inFlightLookups.set(cacheKey, lookup);
  return lookup;
}

const rateCache = new Map<string, FxRate>();
const inFlightLookups = new Map<string, Promise<FxRate | null>>();

/**
 * Convert a receipt amount to USD at the rate for `date` (the payment
 * date). Null means "not convertible": the currency is USD or unknown, the
 * amount isn't parseable, or no rate was available — callers then store the
 * amount as-is and say so. Half-up rounding to cents matches the rest of
 * the app's money math (`mileageAmount`).
 */
export async function convertToUsd(
  amount: string,
  currency: string,
  date: string,
  deps: { fetchRate?: typeof usdRate } = {},
): Promise<FxConversion | null> {
  const code = currency.trim().toUpperCase();
  if (code === "USD" || !isValidCurrencyCode(code)) return null;
  const value = parseAmount(amount);
  if (value === null || !value.isFinite() || value.lte(0)) return null;
  const found = await (deps.fetchRate ?? usdRate)(code, date);
  if (!found) return null;
  const converted = value.times(new Decimal(found.rate)).toFixed(2);
  return {
    currency: code,
    originalAmount: value.toFixed(2),
    amount: converted,
    fxRate: found.rate,
    rateDate: found.rateDate,
  };
}
