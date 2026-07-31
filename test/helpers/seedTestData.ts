import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "csv-stringify/sync";
import { ulid } from "ulid";

const DATA_DIR = "data-test";

const EXPENSE_COLUMNS = [
  "id",
  "type",
  "date",
  "report",
  "category",
  "description",
  "amount",
  "merchant",
  "imageFile",
  "imageMime",
  "originalName",
  "distanceMiles",
  "locations",
  "createdAt",
  "updatedAt",
];

/** Seed the test data directory with known expenses, reports, categories, and settings. */
export async function seedTestData() {
  await mkdir(join(DATA_DIR, "images"), { recursive: true });

  // Reports
  await writeCsv("reports.csv", ["name"], [["2026 Test"], ["2027 Test"]]);

  // Categories
  await writeCsv(
    "categories.csv",
    ["name"],
    [["Testing"], ["Development"], ["Office Supplies"]],
  );

  // Settings
  await writeCsv(
    "settings.csv",
    ["key", "value"],
    [
      ["homeAddress", "123 Test St, Testing, CA"],
      ["homeLat", "34.0522"],
      ["homeLng", "-118.2437"],
      ["mileageRate.2026", "0.70"],
      ["mileageRate.2027", "0.72"],
    ],
  );

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
      locations: "",
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
      locations: "",
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
      locations: JSON.stringify([
        { address: "123 Test St, Testing, CA", lat: 34.0522, lng: -118.2437 },
        { address: "456 Dev Ave, Coding, CA", lat: 34.0622, lng: -118.2537 },
      ]),
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
      locations: "",
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
      locations: "",
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
      locations: "",
      createdAt: now,
      updatedAt: now,
    },
  ];

  const rows = [
    EXPENSE_COLUMNS,
    ...expenses.map((e) =>
      EXPENSE_COLUMNS.map((k) => (e as Record<string, string>)[k] ?? ""),
    ),
  ];
  await writeCsv("expenses.csv", EXPENSE_COLUMNS, rows.slice(1));

  // Mileage CSV (derived artifact)
  const mileageRows = [["date", "report", "locations", "distanceMiles"]];
  for (const e of expenses) {
    if (e.type === "mileage") {
      mileageRows.push([e.date, e.report, e.locations, e.distanceMiles]);
    }
  }
  await writeCsv(
    "mileage.csv",
    ["date", "report", "locations", "distanceMiles"],
    mileageRows.slice(1),
  );
}

async function writeCsv(file: string, header: string[], rows: string[][]) {
  const content = stringify([header, ...rows], { quoted_string: true });
  const path = join(DATA_DIR, file);
  const tmp = path + ".tmp";
  await writeFile(tmp, content, "utf-8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, path);
}
