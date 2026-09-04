/**
 * Seed the test database (expense_test) with two accounts, three users, and
 * known expenses/reports/categories/settings. Requires Postgres running
 * locally (the schema is created by `pnpm test:db:push`; globalSetup ensures
 * it before seeding). Idempotent: replaces all rows on each call. Foreign
 * keys cascade, so deleting accounts wipes everything.
 */
import { ulid } from "ulid";
import { legacyClient, makeTestClient } from "./legacyClient";
import { TEST_DB_URL } from "./seedTestDataUrls";
import { hashPassword } from "~/lib/passwords";

/**
 * Test-only v7-shaped client pinned to expense_test; never inherits the
 * process DATABASE_URL (which may point at the dev database).
 */
const testDb = makeTestClient();
export const testPrisma = legacyClient(testDb.client, testDb.disconnect);

export { TEST_DB_URL };

/** Test account: the default login (testuser) belongs here. */
export const TEST_ACCOUNT_ID = "acct_test1";
export const TEST_INVITE_CODE = "TESTCODE1";

/** Second account, used to prove data isolation between accounts. */
export const OTHER_ACCOUNT_ID = "acct_test2";

/** Test login credentials (matches the seeded testuser row). */
export const TEST_EMAIL = "testuser@example.com";
export const TEST_PASSWORD = "test-password";

export async function seedTestData() {
  const now = "2026-06-15T00:00:00.000Z";

  // Wipe everything; accounts cascade to users + all scoped rows. The
  // mint-cooldown table has no account FK (keyed by base address, global
  // by design) — without an explicit wipe, rows from a previous run
  // suppress this run's first mints.
  await testPrisma.inboundEmailCooldown.deleteMany({});
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
        email: TEST_EMAIL,
        passwordHash: await hashPassword(TEST_PASSWORD),
        // Seeded users are pre-verified; the signup flows under test verify
        // through the emailed-link route instead.
        emailVerifiedAt: now,
        createdAt: now,
      },
      {
        id: "user_test2",
        accountId: OTHER_ACCOUNT_ID,
        email: "otheruser@example.com",
        passwordHash: await hashPassword("other-password"),
        emailVerifiedAt: now,
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
      distanceMiles: null,
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
      distanceMiles: null,
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
      distanceMiles: null,
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
      distanceMiles: null,
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
      distanceMiles: null,
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
      distanceMiles: null,
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

  // Mileage expenses live entirely in the expenses table; the derived
  // mileage table was dropped.
}

/** Create (or ensure) a verified inbound sender for a test: the From
 * address rows the receipts-by-email pipeline checks. `verified: false`
 * leaves the sender pending (row without a verification). Shared by the
 * inbound suites; callers keep their own cleanup bookkeeping. */
export async function allowSender(
  accountId: string,
  address: string,
  createdAt = new Date().toISOString(),
  verified = true,
): Promise<void> {
  const normalized = address.toLowerCase();
  await testPrisma.inboundSender.createMany({
    data: [{ accountId, address: normalized, createdAt }],
    skipDuplicates: true,
  });
  if (verified) {
    await testPrisma.inboundSenderVerification.createMany({
      data: [{ address: normalized, accountId, verifiedAt: createdAt }],
      skipDuplicates: true,
    });
  }
}
