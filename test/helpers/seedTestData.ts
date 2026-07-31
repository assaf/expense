/**
 * Seed the test database (expensify_test) with two accounts, three users, and
 * known expenses/reports/categories/settings. Requires Postgres running
 * locally — the schema is created by `pnpm test:db:push` (globalSetup ensures
 * it before seeding). Idempotent: replaces all rows on each call. Foreign
 * keys cascade, so deleting accounts wipes everything.
 */
import { ulid } from "ulid";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "prisma/generated";
import { hashPassword } from "~/lib/passwords";

export const TEST_DB_URL = "postgres://assaf@localhost/expensify_test";

/**
 * Test-only Prisma client pinned to expensify_test — never inherits the
 * process DATABASE_URL (which may point at the dev database).
 */
export const testPrisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: TEST_DB_URL,
    max: 2,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  }),
});

/** Test account — the default login (testuser) belongs here. */
const TEST_ACCOUNT_ID = "acct_test1";
export const TEST_INVITE_CODE = "TESTCODE1";

/** Second account — used to prove data isolation between accounts. */
export const OTHER_ACCOUNT_ID = "acct_test2";

/** Test login credentials (matches the seeded testuser row). */
export const TEST_USERNAME = "testuser";
export const TEST_PASSWORD = "test-password";

export async function seedTestData() {
  const now = "2026-06-15T00:00:00.000Z";

  // Wipe everything; accounts cascade to users + all scoped rows.
  await testPrisma.account.deleteMany({});

  // --- Accounts & users ----------------------------------------------------
  await testPrisma.account.createMany({
    data: [
      {
        id: TEST_ACCOUNT_ID,
        name: "Test Account",
        inviteCode: TEST_INVITE_CODE,
        createdAt: now,
      },
      {
        id: OTHER_ACCOUNT_ID,
        name: "Other Account",
        inviteCode: "TESTCODE2",
        createdAt: now,
      },
    ],
  });

  await testPrisma.user.createMany({
    data: [
      {
        id: "user_test1",
        accountId: TEST_ACCOUNT_ID,
        username: TEST_USERNAME,
        passwordHash: await hashPassword(TEST_PASSWORD),
        name: "Test User",
        createdAt: now,
      },
      {
        id: "user_test2",
        accountId: OTHER_ACCOUNT_ID,
        username: "otheruser",
        passwordHash: await hashPassword("other-password"),
        name: "Other User",
        createdAt: now,
      },
    ],
  });

  // --- Reports & categories (per account) ----------------------------------
  await testPrisma.report.createMany({
    data: [
      { name: "2026 Test", accountId: TEST_ACCOUNT_ID },
      { name: "2027 Test", accountId: TEST_ACCOUNT_ID },
      // Isolation fixture: a report that must never appear for testuser.
      { name: "Private Report", accountId: OTHER_ACCOUNT_ID },
    ],
    skipDuplicates: true,
  });
  await testPrisma.category.createMany({
    data: [
      { name: "Testing", accountId: TEST_ACCOUNT_ID },
      { name: "Development", accountId: TEST_ACCOUNT_ID },
      { name: "Office Supplies", accountId: TEST_ACCOUNT_ID },
      // Isolation fixture.
      { name: "Confidential", accountId: OTHER_ACCOUNT_ID },
    ],
    skipDuplicates: true,
  });

  // --- Settings (per account) ----------------------------------------------
  await testPrisma.settings.createMany({
    data: [
      {
        accountId: TEST_ACCOUNT_ID,
        key: "homeAddress",
        value: "123 Test St, Testing, CA",
      },
      { accountId: TEST_ACCOUNT_ID, key: "homeLat", value: "34.0522" },
      { accountId: TEST_ACCOUNT_ID, key: "homeLng", value: "-118.2437" },
      { accountId: TEST_ACCOUNT_ID, key: "mileageRate.2026", value: "0.70" },
      { accountId: TEST_ACCOUNT_ID, key: "mileageRate.2027", value: "0.72" },
    ],
  });

  // --- Expenses ------------------------------------------------------------
  const expenses = [
    {
      type: "receipt",
      date: "2026-01-15",
      report: "2026 Test",
      category: "Testing",
      description: "",
      amount: "42.50",
      merchant: "Test Store",
      imageFile: "",
      imageMime: "",
      originalName: "",
      distanceMiles: "",
      locations: [],
      createdAt: now,
      updatedAt: now,
    },
    {
      type: "receipt",
      date: "2026-02-20",
      report: "2026 Test",
      category: "Office Supplies",
      description: "Printer paper",
      amount: "15.99",
      merchant: "OfficeMax",
      imageFile: "",
      imageMime: "",
      originalName: "",
      distanceMiles: "",
      locations: [],
      createdAt: now,
      updatedAt: now,
    },
    {
      type: "mileage",
      date: "2026-03-10",
      report: "2026 Test",
      category: "Development",
      description: "Client visit",
      amount: "22.40",
      merchant: "",
      imageFile: "",
      imageMime: "",
      originalName: "",
      distanceMiles: "32.00",
      locations: [
        { address: "123 Test St, Testing, CA", lat: 34.0522, lng: -118.2437 },
        { address: "456 Dev Ave, Coding, CA", lat: 34.0622, lng: -118.2537 },
      ],
      createdAt: now,
      updatedAt: now,
    },
    {
      type: "receipt",
      date: "2026-04-05",
      report: "2027 Test",
      category: "Development",
      description: "",
      amount: "99.99",
      merchant: "DevShop",
      imageFile: "",
      imageMime: "",
      originalName: "",
      distanceMiles: "",
      locations: [],
      createdAt: now,
      updatedAt: now,
    },
    {
      type: "receipt",
      date: "2026-05-01",
      report: "",
      category: "Testing",
      description: "No report",
      amount: "12.00",
      merchant: "Misc",
      imageFile: "",
      imageMime: "",
      originalName: "",
      distanceMiles: "",
      locations: [],
      createdAt: now,
      updatedAt: now,
    },
    // Incomplete receipt (missing merchant, no image)
    {
      type: "receipt",
      date: "2026-01-01",
      report: "2026 Test",
      category: "Testing",
      description: "",
      amount: "0.00",
      merchant: "",
      imageFile: "",
      imageMime: "",
      originalName: "",
      distanceMiles: "",
      locations: [],
      createdAt: now,
      updatedAt: now,
    },
    // Isolation fixture: belongs to the other account.
    {
      type: "receipt",
      date: "2026-06-01",
      report: "Private Report",
      category: "Confidential",
      description: "",
      amount: "777.00",
      merchant: "Secret Corp",
      imageFile: "",
      imageMime: "",
      originalName: "",
      distanceMiles: "",
      locations: [],
      createdAt: now,
      updatedAt: now,
    },
  ];

  await testPrisma.expense.createMany({
    data: expenses.map((e) => ({
      id: ulid(),
      accountId:
        e.merchant === "Secret Corp" ? OTHER_ACCOUNT_ID : TEST_ACCOUNT_ID,
      ...e,
    })),
  });

  // Mileage table (derived artifact, mirrors the app's rebuild)
  await testPrisma.mileage.createMany({
    data: expenses
      .filter((e) => e.type === "mileage")
      .map((e) => ({
        date: e.date,
        report: e.report,
        locations: e.locations
          .map((l) => l.address)
          .filter(Boolean)
          .join(" → "),
        distanceMiles: e.distanceMiles,
        accountId: TEST_ACCOUNT_ID,
      })),
  });
}
