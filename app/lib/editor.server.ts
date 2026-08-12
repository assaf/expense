import {
  readCategories,
  readMileageRates,
  readPriorMerchants,
  readReports,
  readSettings,
} from "~/lib/database";
import type { MileageRateEntry } from "~/lib/mileage-rates";
import { homeLocation, type Expense, type Location } from "~/lib/types";

/**
 * Editor context shared by the edit loader (/expense/:id) and the create
 * loader (/expense/new): the expense plus the pickers and defaults both
 * editors render — open reports, categories, prior merchants, home location,
 * and the IRS mileage-rate master table (the editor resolves the rate from
 * it by trip date + type, so changing either recomputes the amount).
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
  rates: MileageRateEntry[];
  reportClosed: boolean;
}> {
  const [reports, categories, settings, merchants, rates] = await Promise.all([
    readReports(accountId),
    readCategories(accountId),
    readSettings(accountId),
    readPriorMerchants(accountId),
    readMileageRates(),
  ]);
  const closedReportNames = new Set(
    reports.filter((r) => r.closed).map((r) => r.name),
  );
  return {
    expense,
    // Closed reports can't be selected; the expense's current report is
    // still shown when it is closed (SelectField prepends it as the value).
    reports: reports.filter((r) => !r.closed).map((r) => r.name),
    categories: categories.map((c) => c.name),
    merchants,
    home: homeLocation(settings),
    rates,
    reportClosed: closedReportNames.has(expense.report),
  };
}
