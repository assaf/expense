/**
 * Test-only compatibility client: the v7 query surface (findUnique /
 * findFirst / findMany / count / create / createMany / update / updateMany /
 * delete / deleteMany / upsert with object `where` filters) on top of the
 * Prisma 8 ORM lane. The test suite predates the Prisma 8 migration and
 * asserts through these shapes; the app code uses the native v8 API.
 *
 * Supported where syntax: equality values, null, { in, notIn, lt, lte, gt,
 * gte, eq, neq, not }, OR / AND arrays. `type` fields map to the v8
 * contract's `_type` column name.
 */
import { ulid } from "ulid";
import { and, or } from "@prisma/orm-postgres/orm-client";
import type { Contract } from "../../prisma/contract.d";
import contractJson from "../../prisma/contract.json" with { type: "json" };
import { Pool } from "pg";
import postgres from "@prisma/orm-postgres/runtime";
import { TEST_DB_URL } from "./seedTestDataUrls";

type Expr = ReturnType<typeof and>;

interface FieldProxyLike {
  eq(v: unknown): unknown;
  neq(v: unknown): unknown;
  lt(v: unknown): unknown;
  lte(v: unknown): unknown;
  gt(v: unknown): unknown;
  gte(v: unknown): unknown;
  in(v: readonly unknown[]): unknown;
  notIn(v: readonly unknown[]): unknown;
  isNull(): unknown;
  isNotNull(): unknown;
  like(v: string): unknown;
  ilike(v: string): unknown;
  asc(): unknown;
  desc(): unknown;
}

interface AggregateProxyLike {
  count(): number;
  max(field: string): unknown;
  min(field: string): unknown;
  sum(field: string): unknown;
}

/** Where/create/update inputs (dynamic shapes). */
type Row = Record<string, unknown>;
/**
 * Read results: untyped (dynamic compatibility shim; the app layer carries
 * the real types). Tests narrow with casts where they assert on values.
 */
type ReadRow = Record<string, unknown>;
type ModelProxy = Record<string, FieldProxyLike>;

interface Coll {
  where(filter: Record<string, unknown>): Coll;
  where(f: (m: ModelProxy) => Expr): Coll;
  orderBy(f: (m: ModelProxy) => unknown): Coll;
  orderBy(f: (m: ModelProxy) => unknown[]): Coll;
  orderBy(f: ((m: ModelProxy) => unknown)[]): Coll;
  limit(n: number): Coll;
  offset(n: number): Coll;
  select(...fields: string[]): Coll;
  first(): Promise<ReadRow | null>;
  all(): Promise<ReadRow[]>;
  create(data: Row): Promise<ReadRow>;
  createAll(data: Row[]): Promise<ReadRow[]>;
  update(data: Row): Promise<ReadRow | null>;
  updateAll(data: Row): Promise<ReadRow[]>;
  delete(): Promise<ReadRow | null>;
  deleteAll(): Promise<ReadRow[]>;
  upsert(input: {
    create: Row;
    update: Row;
    conflictOn?: Record<string, unknown>;
  }): Promise<ReadRow>;
  aggregate(
    f: (a: AggregateProxyLike) => Record<string, unknown>,
  ): Promise<ReadRow>;
}

/** Models whose v7 schema generated the id client-side (@default(cuid()));
 * the v8 contract has no such default, so the shim mints a ulid. */
const CLIENT_GENERATED_ID_MODELS = new Set(["ReceiptExtraction"]);

/** v7 model names → v8 contract model names. */
const MODEL_NAMES: Record<string, string> = {
  account: "Account",
  authAttempt: "AuthAttempt",
  category: "Category",
  duplicateDismissal: "DuplicateDismissal",
  emailConnection: "EmailConnection",
  emailProcessLog: "EmailProcessLog",
  emailRule: "EmailRule",
  expense: "Expense",
  imageBlob: "ImageBlob",
  inboundEmail: "InboundEmail",
  inboundSender: "InboundSender",
  inboundSenderVerification: "InboundSenderVerification",
  oAuthClient: "OAuthClient",
  reconciliationRun: "ReconciliationRun",
  receiptExtraction: "ReceiptExtraction",
  report: "Report",
  settings: "Settings",
  user: "User",
};

/** v7 field names → v8 contract field names (PSL reserved words). */
function mapField(name: string): string {
  return name === "type" ? "_type" : name;
}

const OPERATOR_KEYS = new Set([
  "in",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
  "equals",
  "not",
  "startsWith",
  "endsWith",
  "contains",
]);

/** Flatten v7 compound-unique names (`accountId_address: {...}`) into
 * their component equality fields; pass everything else through. */
function mapWhereKeys(where: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR" || k === "AND") {
      out[k] = Array.isArray(v) ? v.map((sub) => mapWhereKeys(sub as Row)) : v;
      continue;
    }
    if (
      k.includes("_") &&
      typeof v === "object" &&
      v !== null &&
      !Array.isArray(v) &&
      Object.keys(v).length > 0 &&
      Object.keys(v).every((ik) => !OPERATOR_KEYS.has(ik))
    ) {
      Object.assign(out, mapWhereKeys(v as Row));
      continue;
    }
    out[mapField(k)] = v;
  }
  return out;
}

const OP_ALIASES: Record<string, keyof FieldProxyLike> = {
  equals: "eq",
  not: "neq",
  in: "in",
  notIn: "notIn",
  lt: "lt",
  lte: "lte",
  gt: "gt",
  gte: "gte",
};

/** Build a v8 predicate expression from a v7 where object. */
function buildExpr(m: ModelProxy, where: Row): Expr {
  const parts: unknown[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (key === "OR" && Array.isArray(value)) {
      parts.push(or(...value.map((sub) => buildExpr(m, sub as Row))));
      continue;
    }
    if (key === "AND" && Array.isArray(value)) {
      parts.push(and(...value.map((sub) => buildExpr(m, sub as Row))));
      continue;
    }
    const field = m[mapField(key)];
    if (field === undefined) {
      throw new Error(`legacyClient: unknown field ${key}`);
    }
    if (value === null) {
      parts.push(field.isNull());
    } else if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      value !== undefined
    ) {
      for (const [op, opVal] of Object.entries(value as Row)) {
        if (op === "startsWith" || op === "endsWith" || op === "contains") {
          const text = String(opVal);
          const pattern =
            op === "startsWith"
              ? `${text}%`
              : op === "endsWith"
                ? `%${text}`
                : `%${text}%`;
          parts.push(field.like(pattern));
          continue;
        }
        const alias = OP_ALIASES[op] ?? op;
        const fn = field[alias as keyof FieldProxyLike];
        if (typeof fn !== "function") {
          throw new Error(`legacyClient: unsupported operator ${op}`);
        }
        parts.push((fn as (v: unknown) => unknown).call(field, opVal));
      }
    } else if (value !== undefined) {
      parts.push(field.eq(value));
    }
  }
  return and(...(parts as Expr[]));
}

/** Normalize a v7 orderBy (object or array of objects) into v8 lambdas. */
/** Normalize a v7 orderBy (object or array of objects) into the v8 shape:
 * an array of lambdas, one per ordering field. */
function buildOrderBy(orderBy: Row | Row[]): ((m: ModelProxy) => unknown)[] {
  const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
  return entries.map((entry) => {
    const [[key, dir]] = Object.entries(entry) as [string, string][];
    return (m: ModelProxy) => {
      const field = m[mapField(key)];
      if (field === undefined) {
        throw new Error(`legacyClient: unknown orderBy field ${key}`);
      }
      return dir === "desc" ? field.desc() : field.asc();
    };
  });
}

/** Map a read row back to v7 field names (`_type` → `type`). */
function mapRow(row: ReadRow | null): ReadRow | null {
  if (row === null || row._type === undefined) return row;
  const { _type, ...rest } = row;
  return { ...rest, type: _type } as ReadRow;
}

/** v7 select objects ({ id: true }) → v8 select field lists. */
function buildSelect(select: Row | undefined): string[] | undefined {
  if (!select) return undefined;
  return Object.keys(select).map(mapField);
}

/****/
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== "object" || current === null) return false;
    const e = current as { code?: unknown; cause?: unknown };
    if (e.code === "23505") return true;
    current = e.cause;
  }
  return false;
}

/** The v7-style model delegate the tests drive. */
function makeDelegate(db: TestClient, modelName: string) {
  const coll = (): Coll =>
    (db.orm.public as unknown as Record<string, unknown>)[
      modelName
    ] as unknown as Coll;

  const applyFilter = (c: Coll, where: Row | undefined): Coll => {
    if (!where || Object.keys(where).length === 0) return c;
    const mapped = mapWhereKeys(where);
    // Pure equality filters can use the shorthand object form; anything
    // with operators needs the lambda form.
    const isSimple = Object.values(mapped).every(
      (v) => v === null || typeof v !== "object" || Array.isArray(v),
    );
    if (isSimple) {
      const entries = Object.entries(mapped).filter(([, v]) => v !== undefined);
      return c.where(Object.fromEntries(entries));
    }
    return c.where((m) => buildExpr(m, mapped));
  };

  const applyShape = (
    c: Coll,
    args: {
      where?: Row;
      orderBy?: Row | Row[];
      select?: Row;
      take?: number;
      skip?: number;
    },
  ): Coll => {
    let out = applyFilter(c, args.where);
    if (args.orderBy) out = out.orderBy(buildOrderBy(args.orderBy));
    if (args.skip !== undefined) out = out.offset(args.skip);
    if (args.take !== undefined) out = out.limit(args.take);
    const fields = buildSelect(args.select);
    if (fields) out = out.select(...fields);
    return out;
  };

  return {
    async count(args?: { where?: Row }): Promise<number> {
      const c = applyFilter(coll(), args?.where);
      const res = await c.aggregate((a) => ({ count: a.count() }));
      return res.count as number;
    },
    async findUnique(args: {
      where: Row;
      select?: Row;
    }): Promise<ReadRow | null> {
      let c = applyFilter(coll(), args.where);
      const fields = buildSelect(args.select);
      if (fields) c = c.select(...fields);
      return mapRow(await c.first());
    },
    async findUniqueOrThrow(args: {
      where: Row;
      select?: Row;
    }): Promise<ReadRow> {
      const row = await this.findUnique(args);
      if (row === null) throw new Error("findUniqueOrThrow: no row");
      return row;
    },
    async findFirst(args: {
      where?: Row;
      orderBy?: Row | Row[];
      select?: Row;
      take?: number;
    }): Promise<ReadRow | null> {
      return mapRow(await applyShape(coll(), args).first());
    },
    async findFirstOrThrow(args: {
      where?: Row;
      orderBy?: Row | Row[];
      select?: Row;
    }): Promise<ReadRow> {
      const row = await this.findFirst(args);
      if (row === null) throw new Error("findFirstOrThrow: no row");
      return row;
    },
    async findMany(args: {
      where?: Row;
      orderBy?: Row | Row[];
      select?: Row;
      take?: number;
      skip?: number;
    }): Promise<ReadRow[]> {
      return (await applyShape(coll(), args).all()).map(
        (r) => mapRow(r) as ReadRow,
      );
    },
    async create(args: { data: Row; select?: Row }): Promise<ReadRow> {
      let c = coll();
      const fields = buildSelect(args.select);
      if (fields) c = c.select(...fields);
      const data = { ...args.data };
      if (data.id === undefined && CLIENT_GENERATED_ID_MODELS.has(modelName)) {
        data.id = ulid();
      }
      return c.create(mapWhereKeys(data));
    },
    async createMany(args: {
      data: Row[];
      skipDuplicates?: boolean;
    }): Promise<{ count: number }> {
      let count = 0;
      for (const row of args.data) {
        try {
          await coll().create(mapWhereKeys(row));
          count++;
        } catch (err) {
          if (args.skipDuplicates && isUniqueViolation(err)) continue;
          throw err;
        }
      }
      return { count };
    },
    async update(args: { where: Row; data: Row }): Promise<ReadRow | null> {
      return mapRow(
        await applyFilter(coll(), args.where).update(mapWhereKeys(args.data)),
      );
    },
    async updateMany(args: {
      where: Row;
      data: Row;
    }): Promise<{ count: number }> {
      const rows = await applyFilter(coll(), args.where).updateAll(
        mapWhereKeys(args.data),
      );
      return { count: rows.length };
    },
    async delete(args: { where: Row }): Promise<ReadRow | null> {
      return applyFilter(coll(), args.where).delete();
    },
    async deleteMany(args: { where?: Row }): Promise<{ count: number }> {
      const rows = await applyFilter(coll(), args?.where ?? {}).deleteAll();
      return { count: rows.length };
    },
    async upsert(args: {
      where: Row;
      create: Row;
      update: Row;
    }): Promise<ReadRow> {
      return coll().upsert({
        create: mapWhereKeys(args.create),
        update: mapWhereKeys(args.update),
        conflictOn: mapWhereKeys(args.where),
      });
    },
  };
}

type TestClient = ReturnType<typeof postgres<Contract>>;

/**
 * The v7-shaped test client: `testPrisma.expense.findFirst({ where: ... })`.
 * Talks to expense_test only; never inherits DATABASE_URL. `$disconnect()`
 * ends the pool (the façade's close() does not own a caller-supplied pool).
 */
type Delegate = ReturnType<typeof makeDelegate>;
export type TestPrismaClient = {
  [K in keyof typeof MODEL_NAMES]: Delegate;
} & { $disconnect: () => Promise<void> };

export function legacyClient(
  db: TestClient,
  disconnect: () => Promise<void>,
): TestPrismaClient {
  const delegates: Record<string, Delegate> = {};
  for (const [v7Name, v8Name] of Object.entries(MODEL_NAMES)) {
    delegates[v7Name] = makeDelegate(db, v8Name);
  }
  return { ...delegates, $disconnect: disconnect } as TestPrismaClient;
}

/** A Prisma 8 client pinned to expense_test (test seed + assertions). */
export function makeTestClient(): {
  client: TestClient;
  disconnect: () => Promise<void>;
} {
  const pool = new Pool({
    connectionString: TEST_DB_URL,
    max: 2,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });
  return {
    client: postgres<Contract>({ contractJson, pg: pool }),
    disconnect: () => pool.end(),
  };
}
