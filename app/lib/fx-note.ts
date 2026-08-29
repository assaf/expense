/**
 * The human-readable conversion note carried in an expense's description
 * when a receipt was captured in a foreign currency: either the applied USD
 * conversion (rate + as-of date) or the fact that none was possible. One
 * strict format is both emitted and parsed here, so repeated saves and
 * date re-converts replace the note in place (`withConversionNote` strips
 * its own prior output first) instead of stacking copies, and the editor
 * can recover the as-of date from a stored description
 * (`readConversionNote`). Text around the note is never touched.
 */

export interface ConversionNoteFields {
  /** ISO 4217 code of the receipt's currency. */
  currency: string;
  /** The printed amount in `currency`. */
  originalAmount: string;
  /** USD per 1 unit, as used; "" when no conversion happened. */
  fxRate: string;
  /** YYYY-MM-DD the rate is as-of (prior business day for weekend
   * purchases); "" when unknown. */
  rateDate: string;
}

/** The provenance quad for a captured receipt: the receipt's currency plus
 * the printed amount and applied rate when the receipt is foreign, "" when
 * not (USD receipts carry no provenance). `conversion` is null when no rate
 * was available; a foreign currency with no rate stays stored-as-is. One
 * copy of the invariant for every capture path (email, MCP, manual save,
 * editor preview): build it once, feed it to `withConversionNote` and the
 * expense row alike. */
export function fxProvenance(
  currency: string,
  originalAmount: string,
  conversion: { fxRate: string; rateDate: string } | null,
): ConversionNoteFields {
  const foreign = currency !== "USD";
  return {
    currency,
    originalAmount: foreign ? originalAmount : "",
    fxRate: foreign && conversion ? conversion.fxRate : "",
    rateDate: foreign && conversion ? conversion.rateDate : "",
  };
}

/** Matches exactly what `conversionNote` emits (with one leading space when
 * appended after user text). Kept in lockstep with the two templates below:
 * a formatting change here must be mirrored there. */
const NOTE_RE =
  / ?\((?:Converted from [A-Z]{3} \d+(?:\.\d{1,2})? at \d+(?:\.\d{1,6})? USD\/[A-Z]{3}(?:, ECB rate for \d{4}-\d{2}-\d{2})?|Amount is in [A-Z]{3}; no exchange rate was available, stored as-is)\.\)/g;

/** The note's rate display: trailing zeros from the numeric(10,6) wire
 * format are trimmed so a re-save doesn't turn "1.1699" into "1.169900". */
function formatFxRate(fxRate: string): string {
  return fxRate.includes(".")
    ? fxRate.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")
    : fxRate;
}

/** The parenthesized note for a conversion, or "" when there is nothing to
 * document (a USD receipt, valid or not). */
export function conversionNote(fx: ConversionNoteFields): string {
  if (!/^[A-Z]{3}$/.test(fx.currency) || fx.currency === "USD") return "";
  if (!fx.fxRate) {
    return `(Amount is in ${fx.currency}; no exchange rate was available, stored as-is.)`;
  }
  const asOf = fx.rateDate ? `, ECB rate for ${fx.rateDate}` : "";
  return `(Converted from ${fx.currency} ${fx.originalAmount} at ${formatFxRate(fx.fxRate)} USD/${fx.currency}${asOf}.)`;
}

export function withConversionNote(
  description: string,
  fx: ConversionNoteFields,
): string {
  const base = description.replace(NOTE_RE, "").trimEnd();
  const note = conversionNote(fx);
  if (!note) return base;
  return base ? `${base} ${note}` : note;
}

/** Recover the applied rate and its as-of date from a stored description.
 * Null when the description carries no converted-note (no note, or the
 * stored-as-is variant which has no rate to recover). */
export function readConversionNote(
  description: string,
): { fxRate: string; rateDate: string } | null {
  const m =
    /\(Converted from [A-Z]{3} \d+(?:\.\d{1,2})? at (\d+(?:\.\d{1,6})?) USD\/[A-Z]{3}(?:, ECB rate for (\d{4}-\d{2}-\d{2}))?\.\)/.exec(
      description,
    );
  return m ? { fxRate: m[1]!, rateDate: m[2] ?? "" } : null;
}
