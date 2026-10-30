import { cronTick } from "~/lib/cron.server";
import { sendEmail } from "~/lib/reply.server";
import { db } from "~/lib/prisma.server";
import { escapeHtml } from "~/lib/escape";
import { FASTMAIL_TOKEN } from "~/lib/env";
import type { Route } from "./+types/api.user-report-cron";

/**
 * Weekly all-users report email.
 *
 * Saturdays at 8am Pacific (16:00 UTC = 8am PST / 9am PDT), fired by
 * `.github/workflows/user-report.yml`. It is not in `vercel.json` because the
 * Hobby plan caps cron jobs at two and both slots are the mail-ingestion
 * crons; the route still gates on CRON_SECRET, so any caller can run it.
 */

export const config = { maxDuration: 60 };

export async function loader({ request }: Route.LoaderArgs) {
  return cronTick(request, {
    name: "user-report-cron",
    crontab: "0 16 * * 6",
    configured: Boolean(FASTMAIL_TOKEN),
    configuredError: "FASTMAIL_TOKEN is not configured on this deployment",
    run: async () => {
      // Three flat reads rather than a relation join: the ORM lane has no
      // `include`, and the per-account expense totals come back as one
      // grouped aggregate instead of a row per expense.
      const [accounts, users, expenseStats] = await Promise.all([
        db.orm.public.Account.select("id", "name").all(),
        db.orm.public.User.select(
          "id",
          "accountId",
          "email",
          "createdAt",
        ).all(),
        db.orm.public.Expense.groupBy("accountId").aggregate((a) => ({
          count: a.count(),
          last: a.max("createdAt"),
        })),
      ]);

      const accountNames = new Map(accounts.map((a) => [a.id, a.name]));
      const stats = new Map(expenseStats.map((s) => [s.accountId, s]));

      // Group by user
      const userMap = new Map<
        string,
        {
          name: string;
          email: string;
          joined_at: string;
          expense_count: number;
          last_expense_at: string | null;
        }
      >();

      for (const user of users) {
        const account = stats.get(user.accountId);
        userMap.set(user.id, {
          name: accountNames.get(user.accountId) ?? "",
          email: user.email,
          joined_at: user.createdAt,
          expense_count: account?.count ?? 0,
          last_expense_at: account?.last ?? null,
        });
      }

      const rows = Array.from(userMap.values()).sort(
        (a, b) =>
          new Date(b.joined_at).getTime() - new Date(a.joined_at).getTime(),
      );

      if (rows.length === 0) {
        return { sent: false, reason: "no users found" };
      }

      const rowsHtml = rows
        .map(
          (r: {
            name: string;
            email: string;
            joined_at: string;
            expense_count: number;
            last_expense_at: string | null;
          }) => {
            const joinedDate = new Date(r.joined_at).toLocaleDateString(
              "en-US",
              { year: "numeric", month: "short", day: "numeric" },
            );
            const lastExpenseDate = r.last_expense_at
              ? new Date(r.last_expense_at).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })
              : "—";
            return `
        <tr>
          <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb">${escapeHtml(r.name)}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb">${escapeHtml(r.email)}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; text-align: right">${joinedDate}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; text-align: right">${r.expense_count}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; text-align: right">${lastExpenseDate}</td>
        </tr>`;
          },
        )
        .join("");

      const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Expense — All Users Report</title></head>
<body style="font-family: -apple-system,system-ui,Segoe UI,Roboto,sans-serif; font-size: 14px; line-height: 1.5; color: #1f2937; padding: 24px">
  <h1 style="font-size: 20px; font-weight: 600; margin: 0 0 8px">Expense — All Users Report</h1>
  <p style="margin: 0 0 16px; font-size: 14px; color: #6b7280">
    ${rows.length} account${rows.length !== 1 ? "s" : ""}&nbsp;•&nbsp;
    ${new Date().toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    })}
  </p>
  <table style="border-collapse: collapse; width: 100%; max-width: 800px">
    <thead>
      <tr style="text-align: left; color: #6b7280; font-size: 12px">
        <th style="padding: 8px 12px">Account</th>
        <th style="padding: 8px 12px">Email</th>
        <th style="padding: 8px 12px; text-align: right">Joined</th>
        <th style="padding: 8px 12px; text-align: right">Expenses</th>
        <th style="padding: 8px 12px; text-align: right">Last Expense</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <p style="margin-top: 20px; font-size: 12px; color: #9ca3af">
    Generated from the Expense database on ${new Date().toLocaleString(
      "en-US",
      {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      },
    )}.
  </p>
</body>
</html>`;

      const ok = await sendEmail({
        to: "assaf@labnotes.org",
        subject: `Expense — All Users Report (${rows.length} account${rows.length !== 1 ? "s" : ""})`,
        html,
      });

      return { sent: ok, count: rows.length };
    },
  });
}
