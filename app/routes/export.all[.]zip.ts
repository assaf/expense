import { zipSync, strToU8 } from "fflate";
import { stringify } from "csv-stringify/sync";
import { requireUser } from "~/lib/auth.server";
import { bareName, readImage } from "~/lib/images.server";
import { readExpenses } from "~/lib/db/expenses";
import { readMileageRates } from "~/lib/db/seed";
import { merchantLabel, sortExpenses } from "~/lib/format";
import type { Route } from "./+types/export.all[.]zip";

/** CSV formula-injection guard (CWE-1236): spreadsheet apps evaluate cells
 * that start with =, +, -, @, tab, or carriage return as formulas. Prefix
 * with a single quote so the value is treated as literal text. Applies to
 * the user-typed fields only; date/amount are app-generated. */
function csvSafe(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const [expenses, rates] = await Promise.all([
    readExpenses(user.accountId),
    readMileageRates(),
  ]);

  const sorted = sortExpenses(expenses, false);

  const csvRows: string[][] = [
    ["date", "merchant", "amount", "category", "report", "description"],
  ];
  for (const e of sorted) {
    csvRows.push([
      e.date,
      csvSafe(merchantLabel(e, rates)),
      e.amount,
      csvSafe(e.category),
      csvSafe(e.report),
      csvSafe(e.description),
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
    files[bareName(e.imageFile, user.accountId)] = new Uint8Array(image.buffer);
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
