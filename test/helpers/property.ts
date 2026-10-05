/**
 * Property-test entry point: one run count and one seed for the whole suite,
 * so a failing property always replays the same counterexample.
 */
import fc from "fast-check";

/** Runs per property. 200 keeps every property in this repo well inside the
 * unit project's 10s per-test timeout; drop to 50 for a slow one rather than
 * raising the timeout. */
const PROPERTY_RUNS = 200;

/** A real calendar date as "YYYY-MM-DD": the input class the day-arithmetic
 * and date-normalization round trips need. */
export const validDate: fc.Arbitrary<string> = fc
  .date({
    min: new Date("2000-01-01T00:00:00Z"),
    max: new Date("2099-12-31T00:00:00Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString().slice(0, 10));

/**
 * Every code point except lone surrogates: the input class that breaks naive
 * char loops. Note the density caveat below before asserting anything that
 * keys on an ASCII character.
 */
export function binary(maxLength: number): fc.Arbitrary<string> {
  return fc.string({ unit: "binary", maxLength });
}

/**
 * Arbitrary text weighted toward printable ASCII, which is what these
 * modules actually parse: `unit: "binary"` alone draws uniformly from all
 * 1.1M code points, so a digit lands in roughly 1 character in 100,000 and a
 * property keyed on digits, quotes or commas would pass vacuously. Mixing in
 * the binary arm keeps the hostile-unicode coverage the rules do need.
 */
export function text(maxLength: number): fc.Arbitrary<string> {
  return fc.oneof(
    { arbitrary: fc.string({ unit: "grapheme-ascii", maxLength }), weight: 7 },
    { arbitrary: binary(maxLength), weight: 3 },
  );
}

export function assertProperty<Ts extends [unknown, ...unknown[]]>(
  arbitraries: { [K in keyof Ts]: fc.Arbitrary<Ts[K]> },
  predicate: (...args: Ts) => void,
  seed = 1,
): void {
  fc.assert(fc.property(...arbitraries, predicate), {
    numRuns: PROPERTY_RUNS,
    seed,
    endOnFailure: true,
  });
}
