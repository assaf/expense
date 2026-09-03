import { and } from "@prisma/orm-postgres/orm-client";
import { db } from "~/lib/prisma.server";
import { summarizeByReport } from "~/lib/format";
import { bust, cachedRead, createCache } from "~/lib/db/shared";
import { addNamedRow, renameNamedRow, type NamedResult } from "~/lib/db/names";
import { deleteReceiptImages, readExpenses } from "~/lib/db/expenses";
import type { Report } from "~/lib/types";

// Reports come back in creation order: auto-increment ids are strictly
// increasing, so `id asc` is chronological: oldest first, newest last.
/** Short-lived per-account cache for reports; they only change when the
 * user edits them in Settings, so a 5-minute TTL is safe. */
const reportsCache = createCache<Report[]>(300_000);

export async function readReports(accountId: string): Promise<Report[]> {
  return cachedRead(reportsCache, accountId, async () => {
    const rows = await db.orm.public.Report.where((r) =>
      and(r.accountId.eq(accountId), r.name.neq("")),
    )
      .orderBy((r) => r.id.asc())
      .select("name", "closed")
      .all();
    return rows.map((r) => ({ name: r.name, closed: r.closed }));
  });
}

/**
 * The set of closed report names, the single definition used everywhere
 * "off the list" is decided: the home page hides closed reports entirely
 * and the editor's prev/next navigation walks the same universe. Pure so
 * callers can feed it either `readReports` output or their own thin
 * Report query.
 */
export function closedReportNames(
  reports: ReadonlyArray<{ name: string; closed: boolean }>,
): Set<string> {
  return new Set(reports.filter((r) => r.closed).map((r) => r.name));
}

/**
 * Expenses per category that belong to reports that are NOT closed (an
 * expense with no report counts, since it isn't in any closed report). Categories
 * are referenced by name; only categories with live expenses appear.
 */
export async function readCategoryCounts(
  accountId: string,
): Promise<Map<string, number>> {
  const [groups, reports] = await Promise.all([
    db.orm.public.Expense.where((e) =>
      and(e.accountId.eq(accountId), e.category.neq("")),
    )
      .groupBy("category", "report")
      .aggregate((agg) => ({ count: agg.count() })),
    db.orm.public.Report.where((r) => r.accountId.eq(accountId))
      .select("name", "closed")
      .all(),
  ]);
  const closed = new Set(reports.filter((r) => r.closed).map((r) => r.name));
  const counts = new Map<string, number>();
  for (const g of groups) {
    if (closed.has(g.report)) continue;
    counts.set(g.category, (counts.get(g.category) ?? 0) + g.count);
  }
  return counts;
}

/** True when a report with this name exists (open or closed). Used by the
 * MCP export_report tool: the report must exist, but closed reports are
 * still exportable. */
export async function reportExists(
  accountId: string,
  name: string,
): Promise<boolean> {
  return (await readReports(accountId)).some((r) => r.name === name);
}

/**
 * Find a report that can accept expenses: exists and is not closed. Returns
 * the report, or an error message when it doesn't exist or is closed. Every
 * "report must exist and be open" check (the web expense save path and the
 * MCP capture_receipt / log_mileage / add_to_report tools) goes through
 * this one helper, so the validation and its error text live in one place.
 */
export async function findOpenReport(
  accountId: string,
  name: string,
): Promise<{ report: Report; error: null } | { report: null; error: string }> {
  const report = (await readReports(accountId)).find((r) => r.name === name);
  if (!report) {
    return {
      report: null,
      error: `Report "${name}" doesn't exist — create it first with create_report.`,
    };
  }
  if (report.closed) {
    return { report: null, error: `Report "${name}" is closed.` };
  }
  return { report, error: null };
}

/** One report's expense count and exact total (2-dp string). */
export interface ReportSummary {
  name: string;
  closed: boolean;
  count: number;
  total: string;
}

/**
 * All reports with their expense counts and exact totals, the shape shared
 * by the export page and the MCP list_reports tool. Counts and totals come
 * from the same summarizeByReport pass, so they always agree.
 */
export async function readReportSummaries(
  accountId: string,
): Promise<ReportSummary[]> {
  const [reports, expenses] = await Promise.all([
    readReports(accountId),
    readExpenses(accountId),
  ]);
  const byReport = summarizeByReport(expenses);
  return reports.map((r) => ({
    name: r.name,
    closed: r.closed,
    count: byReport.get(r.name)?.count ?? 0,
    total: byReport.get(r.name)?.total.toFixed(2) ?? "0.00",
  }));
}

/**
 * Single-report aggregate (count + exact total) via a targeted query
 * (cheaper than loading every expense). Returns null when the report has no
 * expenses (or the report name is blank).
 */
export async function readReportSummary(
  accountId: string,
  reportName: string,
): Promise<{ count: number; total: string } | null> {
  if (!reportName) return null;
  const agg = await db.orm.public.Expense.where((e) =>
    and(e.accountId.eq(accountId), e.report.eq(reportName)),
  ).aggregate((a) => ({ count: a.count(), sum: a.sum("amount") }));
  if (agg.count === 0) return null;
  return {
    count: agg.count,
    total: agg.sum === null ? "0.00" : Number(agg.sum).toFixed(2),
  };
}

/**
 * Create a report if it doesn't exist yet. Returns an error message when
 * the name is empty or already taken.
 */
export function addReport(
  accountId: string,
  name: string,
): Promise<NamedResult> {
  return bust(
    reportsCache,
    accountId,
    addNamedRow(db.orm.public.Report, "report", accountId, name),
  );
}

/**
 * Delete a report together with every expense in it, including their
 * receipt images. Expenses reference reports by name, so the cascade is a
 * same-account name match, executed in one transaction. An empty name is a
 * no-op: it must never touch the "unassigned" expenses (report: "").
 */
export async function removeReport(
  accountId: string,
  name: string,
): Promise<void> {
  if (!name.trim()) return;
  const removed = await db.orm.public.Expense.where((e) =>
    and(e.accountId.eq(accountId), e.report.eq(name)),
  )
    .select("_type", "imageFile")
    .all();
  await deleteReceiptImages(
    accountId,
    removed.map((r) => ({ type: r._type, imageFile: r.imageFile })),
  );
  await db.transaction(async (tx) => {
    await tx.orm.public.Expense.where((e) =>
      and(e.accountId.eq(accountId), e.report.eq(name)),
    ).deleteAll();
    await tx.orm.public.Report.where((r) =>
      and(r.accountId.eq(accountId), r.name.eq(name)),
    ).deleteAll();
  });
  bust(reportsCache, accountId);
}

/**
 * Rename a report and every reference to it: the report row and its
 * expenses. Receipt image keys keep their old convention name; re-saving a
 * receipt rewrites them. Returns an error message when the rename can't
 * happen (empty, unchanged, duplicate).
 */
export function renameReport(
  accountId: string,
  name: string,
  newName: string,
): Promise<NamedResult> {
  return bust(
    reportsCache,
    accountId,
    renameNamedRow(
      db.orm.public.Report,
      "report",
      "report",
      accountId,
      name,
      newName,
    ),
  );
}

/** Mark a report closed (or reopen it). Closed reports delete with confirmation. */
export async function setReportClosed(
  accountId: string,
  name: string,
  closed: boolean,
): Promise<void> {
  await db.orm.public.Report.where((r) =>
    and(r.accountId.eq(accountId), r.name.eq(name)),
  ).updateAll({ closed });
  bust(reportsCache, accountId);
}
