/**
 * Seed the test database (expensify_test) with two accounts, three users, and
 * known expenses/reports/categories/settings. Requires Postgres running
 * locally — the schema is created by the app's initStore on first use
 * (globalSetup ensures it before seeding). Idempotent: replaces all rows on
 * each call. Foreign keys cascade, so deleting accounts wipes everything.
 */
import postgres from "postgres";
import { ulid } from "ulid";
import { hashPassword } from "~/lib/passwords";

export const TEST_DB_URL = "postgres://localhost/expensify_test";

const sql = postgres(TEST_DB_URL, { max: 2 });

/** Test account — the default login (testuser) belongs here. */
export const TEST_ACCOUNT_ID = "acct_test1";
export const TEST_INVITE_CODE = "TESTCODE1";

/** Second account — used to prove data isolation between accounts. */
export const OTHER_ACCOUNT_ID = "acct_test2";

/** Test login credentials (matches the seeded testuser row). */
export const TEST_USERNAME = "testuser";
export const TEST_PASSWORD = "test-password";

export async function seedTestData() {
  const now = "2026-06-15T00:00:00.000Z";
  await sql.begin(async (tx) => {
    // Wipe everything; accounts cascade to users + all scoped rows.
    await tx`DELETE FROM users`;
    await tx`DELETE FROM accounts`;

    // --- Accounts & users --------------------------------------------------
    await tx`INSERT INTO accounts ("id", "name", "inviteCode", "createdAt") VALUES (${TEST_ACCOUNT_ID}, 'Test Account', ${TEST_INVITE_CODE}, ${now})`;
    await tx`INSERT INTO accounts ("id", "name", "inviteCode", "createdAt") VALUES (${OTHER_ACCOUNT_ID}, 'Other Account', 'TESTCODE2', ${now})`;

    const testUserHash = await hashPassword(TEST_PASSWORD);
    await tx`INSERT INTO users ("id", "accountId", "username", "passwordHash", "name", "createdAt") VALUES ('user_test1', ${TEST_ACCOUNT_ID}, 'testuser', ${testUserHash}, 'Test User', ${now})`;

    const otherUserHash = await hashPassword("other-password");
    await tx`INSERT INTO users ("id", "accountId", "username", "passwordHash", "name", "createdAt") VALUES ('user_test2', ${OTHER_ACCOUNT_ID}, 'otheruser', ${otherUserHash}, 'Other User', ${now})`;

    // --- Reports & categories (per account) --------------------------------
    for (const name of ["2026 Test", "2027 Test"]) {
      await tx`INSERT INTO reports ("name", "accountId") VALUES (${name}, ${TEST_ACCOUNT_ID}) ON CONFLICT ("accountId", "name") DO NOTHING`;
    }
    for (const name of ["Testing", "Development", "Office Supplies"]) {
      await tx`INSERT INTO categories ("name", "accountId") VALUES (${name}, ${TEST_ACCOUNT_ID}) ON CONFLICT ("accountId", "name") DO NOTHING`;
    }
    // Isolation fixture: a report that must never appear for testuser.
    await tx`INSERT INTO reports ("name", "accountId") VALUES ('Private Report', ${OTHER_ACCOUNT_ID}) ON CONFLICT ("accountId", "name") DO NOTHING`;
    await tx`INSERT INTO categories ("name", "accountId") VALUES ('Confidential', ${OTHER_ACCOUNT_ID}) ON CONFLICT ("accountId", "name") DO NOTHING`;

    // --- Settings (per account) --------------------------------------------
    const settings: Array<[string, string]> = [
      ["homeAddress", "123 Test St, Testing, CA"],
      ["homeLat", "34.0522"],
      ["homeLng", "-118.2437"],
      ["mileageRate.2026", "0.70"],
      ["mileageRate.2027", "0.72"],
    ];
    for (const [key, value] of settings) {
      await tx`INSERT INTO "settings" ("accountId", "key", "value") VALUES (${TEST_ACCOUNT_ID}, ${key}, ${value})`;
    }

    // --- Expenses -----------------------------------------------------------
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

    for (const e of expenses) {
      const accountId =
        e.merchant === "Secret Corp" ? OTHER_ACCOUNT_ID : TEST_ACCOUNT_ID;
      await tx`INSERT INTO expenses ("id", "type", "date", "report", "category", "description", "amount", "merchant", "imageFile", "imageMime", "originalName", "distanceMiles", "locations", "createdAt", "updatedAt", "accountId") VALUES (${ulid()}, ${e.type}, ${e.date}, ${e.report}, ${e.category}, ${e.description}, ${e.amount}, ${e.merchant}, ${e.imageFile}, ${e.imageMime}, ${e.originalName}, ${e.distanceMiles}, ${JSON.stringify(e.locations)}, ${e.createdAt}, ${e.updatedAt}, ${accountId})`;
    }

    // Mileage table (derived artifact, mirrors the app's rebuildMileage)
    for (const e of expenses) {
      if (e.type !== "mileage") continue;
      const locationsText = e.locations
        .map((l) => l.address)
        .filter(Boolean)
        .join(" → ");
      await tx`INSERT INTO mileage ("date", "report", "locations", "distanceMiles", "accountId") VALUES (${e.date}, ${e.report}, ${locationsText}, ${e.distanceMiles}, ${TEST_ACCOUNT_ID})`;
    }
  });
}
