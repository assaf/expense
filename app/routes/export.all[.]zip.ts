import { zipSync, strToU8 } from "fflate";
import { stringify } from "csv-stringify/sync";
import { requireUser } from "~/lib/auth.server";
import { readImage } from "~/lib/images.server";
import { readExpenses } from "~/lib/store.server";
import { readSettings } from "~/lib/settings.server";
import { mileageMerchant, yearOf } from "~/lib/format";
import type { Expense } from "~/lib/types";
import type { Route } from "./+types/export.all[.]zip";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const [expenses, settings] = await Promise.all([
    readExpenses(user.accountId),
    readSettings(user.accountId),
  ]);

  const sorted = [...expenses].sort((a, b) => {
    if (!a.date && !b.date) return a.createdAt.localeCompare(b.createdAt);
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date.localeCompare(b.date);
  });

  const csvRows: string[][] = [
    ["date", "merchant", "amount", "category", "report", "description"],
  ];
  for (const e of sorted) {
    csvRows.push([
      e.date,
      merchantLabel(e, settings.mileageRates),
      e.amount,
      e.category,
      e.report,
      e.description,
    ]);
  }
  const csv = stringify(csvRows, { quoted_string: true });

  const files: Record<string, Uint8Array> = {
    "expenses.csv": strToU8(csv),
  };

  for (const e of sorted) {
    if (e.type !== "receipt" || !e.imageFile) continue;
    const image = await readImage(user.accountId, e.imageFile);
    if (!image) continue;
    // Strip the account namespace so zip entries keep the plain filename.
    files[e.imageFile.replace(/^images\/[^/]+\//, "")] = new Uint8Array(
      image.buffer,
    );
  }

  const zip = zipSync(files, { level: 9 });

  return new Response(zip, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="expenses-all.zip"`,
      "Cache-Control": "no-store",
    },
  });
}

function merchantLabel(e: Expense, rates: Record<string, string>): string {
  if (e.type === "receipt") return e.merchant;
  return mileageMerchant(e.distanceMiles, rates[yearOf(e.date)] ?? "");
}
