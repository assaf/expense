import { readCategories } from "~/lib/db/categories";
import { readPriorMerchants } from "~/lib/db/expenses";
import { readLocations } from "~/lib/db/locations";
import { closedReportNames, readReports } from "~/lib/db/reports";
import { readMileageRates } from "~/lib/db/seed";
import { readSettings } from "~/lib/db/settings";
import type { MileageRateEntry } from "~/lib/mileage-rates";
import {
  homeLocation,
  type Expense,
  type Location,
  type NamedLocation,
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
