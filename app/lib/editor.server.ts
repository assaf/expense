import { readCategories } from "~/lib/db/categories";
import { readExpenses, readPriorMerchants } from "~/lib/db/expenses";
import { readLocations } from "~/lib/db/locations";
import { closedReportNames, readReports } from "~/lib/db/reports";
import { readMileageRates } from "~/lib/db/seed";
import { readSettings } from "~/lib/db/settings";
import { sortExpenses } from "~/lib/format";
import type { MileageRateEntry } from "~/lib/mileage-rates";
import {
  homeLocation,
  type Expense,
  type Location,
  type NamedLocation,
  type WarrantyExpenseOption,
} from "~/lib/types";

/**
 * Editor context shared by the edit loader (/expense/:id) and the create
 * loader (/expense/new): the expense plus the pickers and defaults both
 * editors render, namely open reports, categories, prior merchants, home location,
 * the account's named locations, and the IRS mileage-rate master table (the
 * editor resolves the rate from it by trip date + type, so changing either
 * recomputes the amount).
 */
export async function loadEditorContext(
  accountId: string,
  expense: Expense,
): Promise<{
  expense: Expense;
  reports: string[];
  categories: string[];
  merchants: string[];
  home: Location;
  locations: NamedLocation[];
  rates: MileageRateEntry[];
  reportClosed: boolean;
}> {
  const [reports, categories, settings, merchants, rates, locations] =
    await Promise.all([
      readReports(accountId),
      readCategories(accountId),
      readSettings(accountId),
      readPriorMerchants(accountId),
      readMileageRates(),
      readLocations(accountId),
    ]);
  const closed = closedReportNames(reports);
  return {
    expense,
    // Closed reports can't be selected; the expense's current report is
    // still shown when it is closed (SelectField prepends it as the value).
    reports: reports.filter((r) => !r.closed).map((r) => r.name),
    categories: categories.map((c) => c.name),
    merchants,
    home: homeLocation(settings),
    locations,
    rates,
    reportClosed: closed.has(expense.report),
  };
}

/** How many recent receipts the warranty editor's linked-expense picker
 * offers. A fixed cap: the select is a convenience (the warranty's own
 * fields are the record), not a search surface. */
const MAX_WARRANTY_RECEIPTS = 100;

/**
 * Warranty editor context shared by /warranty/new and /warranty/:id: the
 * merchant autocomplete source and the recent receipts the linked-expense
 * picker lists (newest first, capped).
 */
export async function loadWarrantyEditorOptions(accountId: string): Promise<{
  merchants: string[];
  receipts: WarrantyExpenseOption[];
}> {
  const [merchants, expenses] = await Promise.all([
    readPriorMerchants(accountId),
    readExpenses(accountId, { type: "receipt" }),
  ]);
  return {
    merchants,
    receipts: sortExpenses(expenses)
      .slice(0, MAX_WARRANTY_RECEIPTS)
      .map((e) => ({
        id: e.id,
        merchant: e.type === "receipt" ? e.merchant : "",
        date: e.date,
        amount: e.amount,
      })),
  };
}
