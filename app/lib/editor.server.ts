import { yearOf } from "~/lib/format";
import { homeLocation, readSettings } from "~/lib/settings.server";
import {
  readCategories,
  readPriorMerchants,
  readReports,
} from "~/lib/store.server";
import type { Expense, Location } from "~/lib/types";

/**
 * Editor context shared by the edit loader (/expense/:id) and the create
 * loader (/expense/new): the expense plus the pickers and defaults both
 * editors render — open reports, categories, prior merchants, home location,
 * and the mileage rate for the expense's year. Callers add `mode` and `nav`.
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
  rate: string;
  year: string;
}> {
  const [reports, categories, settings, merchants] = await Promise.all([
    readReports(accountId),
    readCategories(accountId),
    readSettings(accountId),
    readPriorMerchants(accountId),
  ]);
  const year = yearOf(expense.date);
  return {
    expense,
    // Closed reports can't be selected; the expense's current report is
    // still shown when it is closed (SelectField prepends it as the value).
    reports: reports.filter((r) => !r.closed).map((r) => r.name),
    categories: categories.map((c) => c.name),
    merchants,
    home: homeLocation(settings),
    rate: settings.mileageRates[year] ?? "",
    year,
  };
}
