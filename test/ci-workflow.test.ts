import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vite-plus/test";
import mainConfig from "../vitest.main.config";

/**
 * The deployment gate (`.github/workflows/deployment-checks.yml`) encodes two
 * load-bearing invariants in its job graph rather than in code: prod DDL runs
 * only after the test suite passes, and nothing reaches prod before the schema
 * sync. GitHub's own UI shows the graph, but a refactor that flips an edge
 * ships silently, so pin the ordering the workflow's comments call fatal to
 * get wrong (EXPENSE-18). Also pins the CI env against the main project's env:
 * CI has no `.env`, so a key present in one place and not the other renders a
 * different branch (the Aug 2026 /emails connect-form flake).
 */

const WORKFLOW_PATH = ".github/workflows/deployment-checks.yml";

interface Step {
  run?: string;
}

interface Job {
  needs?: string | string[];
  if?: string;
  env?: Record<string, string>;
  steps?: Step[];
}

const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8")) as {
  jobs: Record<string, Job>;
};

function needsOf(job: Job): string[] {
  if (!job.needs) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

describe("deployment-checks job graph", () => {
  it("runs secretlint first, with no dependency", () => {
    expect(needsOf(workflow.jobs.secretlint!)).toEqual([]);
  });

  it("gates check and test on secretlint only", () => {
    expect(needsOf(workflow.jobs.check!)).toEqual(["secretlint"]);
    expect(needsOf(workflow.jobs.test!)).toEqual(["secretlint"]);
  });

  it("migrates the prod schema only after check and test pass", () => {
    expect(needsOf(workflow.jobs["migrate-db"]!)).toEqual(["check", "test"]);
  });

  it("deploys after the migration, and smokes after the deploy", () => {
    expect(needsOf(workflow.jobs.deploy!)).toEqual(["migrate-db"]);
    expect(needsOf(workflow.jobs["pdf-ocr-smoke"]!)).toEqual(["deploy"]);
  });

  it("keeps prod-only jobs on main behind a successful pipeline", () => {
    for (const name of ["migrate-db", "deploy", "pdf-ocr-smoke"]) {
      const condition = workflow.jobs[name]!.if ?? "";
      expect(condition, `${name} condition`).toContain("success()");
      expect(condition, `${name} condition`).toContain("refs/heads/main");
    }
  });

  it("runs the OCR round trip in CI", () => {
    expect(workflow.jobs.test!.env!.RUN_OCR_TESTS).toBe("1");
  });

  it("agrees with the main project on shared env pins", () => {
    const ciEnv = workflow.jobs.test!.env!;
    const configEnv = (mainConfig.test?.env ?? {}) as Record<string, string>;
    const shared = Object.keys(ciEnv).filter((key) => key in configEnv);
    // Guard against a vacuous pass: the shared set must be non-empty.
    expect(shared.length).toBeGreaterThan(0);
    for (const key of shared) {
      expect(
        ciEnv[key],
        `${key} drifts between CI and vitest.main.config.ts`,
      ).toBe(configEnv[key]);
    }
  });
});

/**
 * `prisma db update` is what syncs prod, from the migrate-db job and from
 * `scripts/deploy`, and its CLI surface has moved under this repo more than
 * once: on 2026-10-10 the rc.22 bump made the `--confirm <dbname>` both
 * invocations passed an error (`CLI.CONSENT_UNUSED`, exit 2) on every
 * non-destructive sync, which is the case the job exists for. Nothing in the
 * suite ran the command, so check and test stayed green and the failure
 * surfaced only in the migrate job, after eight minutes of tests and with the
 * deploy blocked.
 *
 * These run the command each path actually runs, against the throwaway test
 * database and with `--dry-run`, so nothing is applied and the dev database in
 * `.env` is never the target: a flag the installed CLI no longer accepts fails
 * here first, in seconds, instead of on main.
 */
const TEST_DB_URL = "postgres://assaf@localhost/expense_test";

/** The `prisma db update` line out of a shell script or a workflow step,
 * verbatim: a rewrite in either place has to keep working, and copying the
 * command here instead would let the two drift apart silently. */
function dbUpdateLine(source: string): string {
  const line = source
    .split("\n")
    .map((l) => l.trim())
    // Anchored, so a line that merely mentions the command — the
    // `--skip-db-sync` notice in scripts/deploy — is not mistaken for it.
    .find((l) => /^(pnpm\s+)?prisma db update\b/.test(l));
  if (line === undefined) throw new Error("no `prisma db update` line found");
  return line;
}

function runDbUpdateDry(line: string): { status: number | null; out: string } {
  const result = spawnSync(
    "bash",
    ["-c", `${line} --db ${TEST_DB_URL} --dry-run`],
    {
      // prisma.config.ts loads .env (the dev database), so both variables the
      // CLI prefers are pointed at the throwaway one for this child.
      env: {
        ...process.env,
        DATABASE_URL: TEST_DB_URL,
        DATABASE_URL_UNPOOLED: TEST_DB_URL,
      },
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  return {
    status: result.status,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

describe("the prod schema sync", () => {
  it("is a `db update` the installed CLI accepts (migrate-db job)", () => {
    const line = dbUpdateLine(
      (workflow.jobs["migrate-db"]!.steps ?? [])
        .map((s) => s.run ?? "")
        .join("\n"),
    );
    const { status, out } = runDbUpdateDry(line);
    expect(status, out).toBe(0);
    expect(out, out).toContain('"ok":true');
  });

  it("is a `db update` the installed CLI accepts (scripts/deploy)", () => {
    const line = dbUpdateLine(readFileSync("scripts/deploy", "utf8"));
    const { status, out } = runDbUpdateDry(line);
    expect(status, out).toBe(0);
    expect(out, out).toContain('"ok":true');
  });
});
