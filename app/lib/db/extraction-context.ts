import { readCategories } from "~/lib/db/categories";
import { readKnownMerchants } from "~/lib/db/expenses";
import { readReports } from "~/lib/db/reports";
import type { KnownMerchant } from "~/lib/receipt-ai.server";

/**
 * Category names + known merchants: the extraction context shared by the
 * draft-image, inbound-email, and MCP pipelines. The known-merchant map
 * supplies the prior category/report lookups (a merchant's previous
 * category is reused instead of re-guessed) and drives the LLM-skip path.
 *
 * Lives in its own module so it can reach across reports + categories +
 * expenses without creating an import cycle between them.
 */
export async function readExtractionContext(accountId: string): Promise<{
  categories: string[];
  reports: string[];
  knownMerchants: Map<string, KnownMerchant>;
}> {
  const [categoriesRaw, knownMerchants, reports] = await Promise.all([
    readCategories(accountId),
    readKnownMerchants(accountId),
    readReports(accountId),
  ]);
  return {
    categories: categoriesRaw.map((c) => c.name),
    reports: reports.map((r) => r.name),
    knownMerchants,
  };
}
