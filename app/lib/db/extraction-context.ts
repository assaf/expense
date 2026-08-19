import { readCategories } from "~/lib/db/categories";
import { readKnownMerchants } from "~/lib/db/expenses";
import { readReports } from "~/lib/db/reports";
import type { KnownMerchant } from "~/lib/receipt-ai.server";

/**
 * Category names + prior merchant categories/reports + known merchants —
 * the extraction context shared by the draft-image, inbound-email, and MCP
 * pipelines. The merchant's previous category (normalized name match) is
 * reused instead of re-guessed; knownMerchants drives the LLM-skip path.
 *
 * Lives in its own module so it can reach across reports + categories +
 * expenses without creating an import cycle between them.
 */
export async function readExtractionContext(accountId: string): Promise<{
  categories: string[];
  reports: string[];
  merchantCategories: Map<string, string>;
  merchantReports: Map<string, string>;
  knownMerchants: Map<string, KnownMerchant>;
}> {
  const [categoriesRaw, knownMerchants, reports] = await Promise.all([
    readCategories(accountId),
    readKnownMerchants(accountId),
    readReports(accountId),
  ]);
  const merchantCategories = new Map<string, string>();
  const merchantReports = new Map<string, string>();
  for (const [key, m] of knownMerchants) {
    if (m.category) merchantCategories.set(key, m.category);
    if (m.report) merchantReports.set(key, m.report);
  }
  return {
    categories: categoriesRaw.map((c) => c.name),
    reports: reports.map((r) => r.name),
    merchantCategories,
    merchantReports,
    knownMerchants,
  };
}
