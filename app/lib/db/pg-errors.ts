/**
 * Postgres error-code checks. Prisma 8 wraps driver errors in structured
 * envelopes (top-level `code` is a PN-* code), so the Postgres SQLSTATE
 * lives on the error or its `cause` chain.
 */

function hasPgCode(err: unknown, sqlstate: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== "object" || current === null) return false;
    const e = current as { code?: unknown; cause?: unknown };
    if (e.code === sqlstate) return true;
    current = e.cause;
  }
  return false;
}

/** Unique constraint violation (23505). */
export function isUniqueViolation(err: unknown): boolean {
  return hasPgCode(err, "23505");
}

/** Foreign key violation (23503). */
export function isForeignKeyViolation(err: unknown): boolean {
  return hasPgCode(err, "23503");
}
