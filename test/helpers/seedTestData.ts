/**
 * Seed the test database (expensify_test) with known expenses, reports,
 * categories, and settings. Requires Postgres running locally — the schema is
 * created by the app's initStore on first use (globalSetup ensures it before
 * seeding). Idempotent: replaces all rows on each call.
 */
import postgres from "postgres";
import { ulid } from "ulid";

export const TEST_DB_URL = "postgres://localhost/expensify_test";

const sql = postgres(TEST_DB_URL, { max: 2 });

export async function seedTestData() {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM expenses`;
    await tx`DELETE FROM reports`;
    await tx`DELETE FROM categories`;
    await tx`DELETE FROM "settings"`;
    await tx`DELETE FROM mileage`;

    // Reports
    for (const name of ["2026 Test", "2027 Test"]) {
      await tx`INSERT INTO reports ("name") VALUES (${name}) ON CONFLICT ("name") DO NOTHING`;
    }

    // Categories
    for (const name of ["Testing", "Development", "Office Supplies"]) {
      await tx`INSERT INTO categories ("name") VALUES (${name}) ON CONFLICT ("name") DO NOTHING`;
    }

    // Settings
    const settings: Array<[string, string]> = [
      ["homeAddress", "123 Test St, Testing, CA"],
      ["homeLat", "34.0522"],
      ["homeLng", "-118.2437"],
      ["mileageRate.2026", "0.70"],
      ["mileageRate.2027", "0.72"],
    ];
    for (const [key, value] of settings) {
      await tx`INSERT INTO "settings" ("key", "value") VALUES (${key}, ${value})`;
    }

    // Expenses — a mix of receipt and mileage entries
    const now = "2026-06-15T00:00:00.000Z";
    const expenses = [
      {
        id: ulid(),
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
        id: ulid(),
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
        id: ulid(),
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
        id: ulid(),
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
        id: ulid(),
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
        id: ulid(),
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
    ];

    for (const e of expenses) {
      await tx`INSERT INTO expenses ("id", "type", "date", "report", "category", "description", "amount", "merchant", "imageFile", "imageMime", "originalName", "distanceMiles", "locations", "createdAt", "updatedAt") VALUES (${e.id}, ${e.type}, ${e.date}, ${e.report}, ${e.category}, ${e.description}, ${e.amount}, ${e.merchant}, ${e.imageFile}, ${e.imageMime}, ${e.originalName}, ${e.distanceMiles}, ${JSON.stringify(e.locations)}, ${e.createdAt}, ${e.updatedAt})`;
    }

    // Mileage table (derived artifact, mirrors the app's rebuildMileage)
    for (const e of expenses) {
      if (e.type !== "mileage") continue;
      const locationsText = e.locations
        .map((l) => l.address)
        .filter(Boolean)
        .join(" → ");
      await tx`INSERT INTO mileage ("date", "report", "locations", "distanceMiles") VALUES (${e.date}, ${e.report}, ${locationsText}, ${e.distanceMiles})`;
    }
  });
}
