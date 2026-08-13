import { readCategories } from "~/lib/db/categories";
import { readMerchantCategories, readMerchantReports } from "~/lib/db/expenses";
import { readReports } from "~/lib/db/reports";

/**
 * Category names + prior merchant categories + reports — the extraction
 * context shared by the draft-image and inbound-email pipelines. Loading
 * both up front is one round-trip; the merchant's previous category
 * (normalized name match) is reused instead of re-guessed.
 *
 * Lives in its own module so it can reach across reports + categories +
 * expenses without creating an import cycle between them.
 */
export async function readExtractionContext(accountId: string): Promise<{
  categories: string[];
  reports: string[];
  merchantCategories: Map<string, string>;
  merchantReports: Map<string, string>;
}> {
  const [categoriesRaw, merchantCategories, merchantReports, reports] =
    await Promise.all([
      readCategories(accountId),
      readMerchantCategories(accountId),
      readMerchantReports(accountId),
      readReports(accountId),
    ]);
  return {
    categories: categoriesRaw.map((c) => c.name),
    reports: reports.map((r) => r.name),
    merchantCategories,
    merchantReports,
  };
}
