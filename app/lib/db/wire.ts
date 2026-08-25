import type {
  JsonValue,
  Numeric,
  TimestampString,
} from "@prisma/orm-postgres/target/codec-types";

/**
 * Wire-text helpers for Prisma 8's string temporal codecs.
 *
 * The contract declares every timestamp column as `TimestampString(3)`
 * (Postgres `timestamp(3)`), a pass-through codec: reads arrive as the
 * server's wire text (`"2026-08-25 22:21:25.534"`, space separator, no
 * zone) and writes accept the same. The app's domain layer keeps UTC ISO
 * strings (`"2026-08-25T22:21:25.534Z"`), so these helpers convert at the
 * db-layer boundary — the replacements for the v7 `Date → toISOString()`
 * mapper calls. Postgres accepts ISO strings (with `Z`) for timestamp
 * columns and stores the UTC wall time, so writes need no text conversion;
 * only the compile-time brand needs asserting.
 */

/** Wire text → ISO-8601 UTC instant string, milliseconds always shown
 * (matches the v7 Date.toISOString() format the domain layer expects:
 * Postgres prints "2026-07-01 10:00:00" for whole seconds). */
export function toIso(wire: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/.exec(wire);
  if (!m) return wire.replace(" ", "T") + "Z";
  const ms = (m[3] ?? "").slice(0, 3).padEnd(3, "0");
  return `${m[1]}T${m[2]}.${ms}Z`;
}

/** Nullable wire text → ISO string or null. */
export function toIsoOrNull(wire: string | null): string | null {
  return wire === null ? null : toIso(wire);
}

/** ISO string (or any Postgres timestamp text) → timestamp write value. */
export function fromIso(iso: string): TimestampString<3> {
  return iso as TimestampString<3>;
}

/** Nullable ISO string → nullable timestamp write value. */
export function fromIsoOrNull(iso: string | null): TimestampString<3> | null {
  return iso === null ? null : (iso as TimestampString<3>);
}

/** Decimal text → numeric write value (the codec is string pass-through). */
export function asNumericOf<P extends number, S extends number>(
  text: string,
): Numeric<P, S> {
  return text as Numeric<P, S>;
}

/** Decimal text → numeric(10,2) write value (expense amounts). */
export function asNumeric(text: string): Numeric<10, 2> {
  return text as Numeric<10, 2>;
}

/** JSON-serializable value → jsonb write value. */
export function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}
