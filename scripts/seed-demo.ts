/**
 * Seed a demo account with realistic data for the recorded MCP demo
 * (docs/mcp-demo.md). Creates (or replaces) the "Demo Account" with:
 *  - merchant history (Blue Bottle Coffee × 3) so capture_receipt reuses a
 *    category from the account's own history
 *  - Travel expenses in Q2 so the spending question has a real answer
 *  - unreported June expenses so the "move into the Q2 report" move has work
 *  - a mileage trip + rate so mileage is priced at the IRS rate
 *
 * Idempotent: drops and recreates the demo account on every run.
 * Run against the local dev DB (server running):  pnpm demo:seed
 */
import "dotenv/config";
import { promisify } from "node:util";
import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../prisma/generated/client.ts";
import { ulid } from "ulid";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

const DEMO_ACCOUNT_NAME = "Demo Account";
const DEMO_EMAIL = "demo@example.com";
const DEMO_PASSWORD = "demo-password";

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  }),
});

const now = new Date().toISOString();

/** scrypt hash in the app's `salt:hash` format (see app/lib/passwords.ts). */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString("hex")}`;
}

/** A receipt expense row (see prisma/schema.prisma → Expense). */
function receipt(input: {
  id: string;
  date: string;
  merchant: string;
  amount: string;
  category: string;
  report?: string;
  description?: string;
}) {
  return {
    id: input.id,
    type: "receipt",
    date: input.date,
    report: input.report ?? "",
    category: input.category,
    description: input.description ?? "",
    amount: input.amount,
    merchant: input.merchant,
    imageFile: "",
    imageMime: "",
    originalName: "",
    distanceMiles: null,
    locations: [],
    route: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** A mileage expense row + its derived mileage-table row. */
function mileage(input: {
  id: string;
  date: string;
  amount: string;
  distanceMiles: string;
  category: string;
  report?: string;
  description?: string;
}) {
  const locations = [
    { address: "123 Main St, Los Angeles, CA", lat: 34.0522, lng: -118.2437 },
    {
      address: "456 Studio Ave, Santa Monica, CA",
      lat: 34.0195,
      lng: -118.4912,
    },
  ];
  return {
    expense: {
      id: input.id,
      type: "mileage",
      date: input.date,
      report: input.report ?? "",
      category: input.category,
      description: input.description ?? "",
      amount: input.amount,
      merchant: "",
      imageFile: "",
      imageMime: "",
      originalName: "",
      distanceMiles: input.distanceMiles,
      locations,
      route: { coords: [], returnCoords: [] },
      createdAt: now,
      updatedAt: now,
    },
    mileageRow: {
      date: input.date,
      report: input.report ?? "",
      locations: locations.map((l) => l.address).join(" → "),
      distanceMiles: input.distanceMiles,
      accountId: "",
    },
  };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL is required — run against the local dev DB (.env).",
    );
    process.exit(1);
  }

  // Idempotent: replace the whole demo account (cascades users/expenses/…).
  await prisma.account.deleteMany({ where: { name: DEMO_ACCOUNT_NAME } });

  const accountId = `demo_${ulid()}`;
  const userId = `demo_${ulid()}`;
  await prisma.$transaction([
    prisma.account.create({
      data: {
        id: accountId,
        name: DEMO_ACCOUNT_NAME,
        inviteCode: "DEMODEMO",
        createdAt: now,
      },
    }),
    prisma.user.create({
      data: {
        id: userId,
        accountId,
        email: DEMO_EMAIL,
        passwordHash: await hashPassword(DEMO_PASSWORD),
        createdAt: now,
      },
    }),
  ]);

  const categories = [
    "Meals & Entertainment",
    "Travel",
    "Software",
    "Office Supplies",
    "Car & Truck",
    "Advertising",
    "Insurance",
    "Legal & Professional",
  ];
  await prisma.category.createMany({
    data: categories.map((name) => ({ name, accountId })),
  });

  await prisma.report.createMany({
    data: [
      { name: "Q2 2026", accountId },
      { name: "Q3 2026", accountId },
    ],
  });

  await prisma.settings.createMany({
    data: [
      { accountId, key: "homeAddress", value: "123 Main St, Los Angeles, CA" },
      { accountId, key: "homeLat", value: "34.0522" },
      { accountId, key: "homeLng", value: "-118.2437" },
    ],
  });

  // Merchant history — capture_receipt reuses the merchant's previous
  // category instead of guessing (see resolveCategory in receipt-ai.server.ts).
  const history = [
    receipt({
      id: "demo_hist1",
      date: "2026-02-12",
      merchant: "Blue Bottle Coffee",
      amount: "6.50",
      category: "Meals & Entertainment",
    }),
    receipt({
      id: "demo_hist2",
      date: "2026-04-18",
      merchant: "Blue Bottle Coffee",
      amount: "8.75",
      category: "Meals & Entertainment",
    }),
    receipt({
      id: "demo_hist3",
      date: "2026-05-09",
      merchant: "Blue Bottle Coffee",
      amount: "5.90",
      category: "Meals & Entertainment",
    }),
  ];

  // Q2 Travel — the spending question answers "Travel, Apr–Jun: $391.30".
  const q2 = [
    receipt({
      id: "demo_flight1",
      date: "2026-04-05",
      merchant: "United Airlines",
      amount: "212.40",
      category: "Travel",
      report: "Q2 2026",
      description: "LAX → SFO",
    }),
    receipt({
      id: "demo_flight2",
      date: "2026-06-15",
      merchant: "United Airlines",
      amount: "178.90",
      category: "Travel",
      report: "Q2 2026",
      description: "SFO → LAX",
    }),
  ];

  // Unreported June expenses — the "move into the Q2 report" move.
  const unreported = [
    receipt({
      id: "demo_figma",
      date: "2026-06-03",
      merchant: "Figma",
      amount: "15.00",
      category: "Software",
      description: "Professional plan",
    }),
    receipt({
      id: "demo_staples",
      date: "2026-06-21",
      merchant: "Staples",
      amount: "42.30",
      category: "Office Supplies",
      description: "Printer paper + ink",
    }),
    receipt({
      id: "demo_coffee",
      date: "2026-06-27",
      merchant: "Blue Bottle Coffee",
      amount: "7.25",
      category: "Meals & Entertainment",
    }),
  ];

  const demoMileage = mileage({
    id: "demo_drive",
    date: "2026-06-10",
    amount: "23.10",
    distanceMiles: "33.00",
    category: "Car & Truck",
    description: "Client visit",
  });

  const q3 = [
    receipt({
      id: "demo_amazon",
      date: "2026-07-08",
      merchant: "Amazon",
      amount: "67.99",
      category: "Office Supplies",
      report: "Q3 2026",
      description: "Monitor stand",
    }),
  ];

  const expenses = [
    ...history,
    ...q2,
    ...unreported,
    demoMileage.expense,
    ...q3,
  ].map((e) => ({ ...e, accountId }) as Prisma.ExpenseCreateManyInput);
  await prisma.expense.createMany({ data: expenses });

  await prisma.mileage.createMany({
    data: [{ ...demoMileage.mileageRow, accountId }],
  });

  console.info("Seeded Demo Account:");
  console.info("  account:", DEMO_ACCOUNT_NAME, `(${accountId})`);
  console.info("  login:  ", DEMO_EMAIL, "/", DEMO_PASSWORD);
  console.info(
    "  travel Q2: $391.30 across 2 expenses (the spending question)",
  );
  console.info("  unreported June: 4 expenses (the report move)");
  console.info(
    "  blue bottle history: 3 receipts (capture reuses its category)",
  );
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
