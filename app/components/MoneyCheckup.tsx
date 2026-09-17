import { Link } from "react-router";

import { countLabel, formatShortDate, formatUsd } from "~/lib/format";
import { NOTHING_OUTSTANDING, type Checkup } from "~/lib/money-checkup";

/** Every link in the panel: one recipe, so the rows and the actions read as
 * one family. */
const LINK =
  "text-xs text-gray-600 underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500 dark:text-gray-300 dark:decoration-gray-600";

/**
 * The money checkup panel: the same findings the answer step and the
 * opening starter read, rendered as links to the rows and pages that fix
 * them. Pure render, no hooks: the page hands it the checkup it computed
 * from the loader's expense snapshot and the browser's local date.
 */
export function MoneyCheckup({ checkup }: { checkup: Checkup }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="text-sm font-medium text-gray-800 dark:text-gray-100">
          Money checkup
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {formatShortDate(checkup.since)} - {formatShortDate(checkup.until)}
        </p>
      </div>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
        {formatUsd(checkup.spent)} across {countLabel(checkup.count)} this year.
      </p>
      {checkup.pace ? (
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          At this rate: about {formatUsd(checkup.pace.annual)} by December 31 (a
          straight line, not a prediction).
        </p>
      ) : null}
      {checkup.findings.length === 0 ? (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          {NOTHING_OUTSTANDING}
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {checkup.findings.map((finding) => (
            <li key={finding.kind}>
              <p className="text-sm font-medium text-gray-800 dark:text-gray-100">
                {finding.title}
              </p>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                {finding.detail}
                {finding.facts ? ` ${finding.facts}` : ""}
              </p>
              {finding.links.length > 0 || finding.action ? (
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {finding.links.map((row) => (
                    <Link
                      key={row.id}
                      to={`/expense/${row.id}`}
                      className={LINK}
                    >
                      {row.label}
                      {row.amount ? ` · ${row.amount}` : ""}
                    </Link>
                  ))}
                  {finding.action ? (
                    <Link to={finding.action.href} className={LINK}>
                      {finding.action.label}
                    </Link>
                  ) : null}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
