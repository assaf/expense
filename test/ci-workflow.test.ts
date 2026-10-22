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
 * On 2026-10-22 the rc.24 bump moved the `"ok":true` envelope behind `--json`:
 * the default output became a pretty planner preview, so the marker this test
 * pins on stopped appearing while the command still exited 0. The run now
 * passes `--json`, which is the machine-readable surface and carries the
 * success marker the guard wants.
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
    // --json keeps the success marker machine-readable: since rc.24 the
    // default output is a pretty planner preview, and only --json still
    // emits the `"ok":true` envelope this drift-guard pins on.
    ["-c", `${line} --db ${TEST_DB_URL} --dry-run --json`],
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

/**
 * A failed smoke is supposed to put the previous deployment back in
 * production. `vercel rollback <target>` makes <target> the production
 * deployment, so the target has to be the deployment that was live BEFORE
 * the failed one; passing the failed one is a no-op Vercel refuses (422
 * "Cannot rollback to this deployment, as it the current production
 * deployment"). Both paths shipped that, and the CI one hid the refusal
 * behind `|| echo`, so the safety net could fail without failing visibly
 * (2026-10-20). Nothing in the job graph shows which deployment is the
 * target, so pin it in both places.
 */
describe("the rollback target", () => {
  const sources: [string, string][] = [
    ["scripts/deploy", readFileSync("scripts/deploy", "utf8")],
    [
      "pdf-ocr-smoke job",
      (workflow.jobs["pdf-ocr-smoke"]!.steps ?? [])
        .map((s) => s.run ?? "")
        .join("\n"),
    ],
  ];

  for (const [name, source] of sources) {
    it(`${name} rolls back to the previous deployment, not the failed one`, () => {
      expect(source, name).toContain("scripts/previous-deployment");
      // The failed deployment is the URL the smoke ran against; it must
      // never be the rollback target.
      expect(source, name).not.toMatch(/rollback\s+"\$(DEPLOY_)?URL"/);
    });
  }

  it("fails loudly in CI when the previous deployment cannot be determined", () => {
    const smokeJob = workflow.jobs["pdf-ocr-smoke"]!;
    const run = (smokeJob.steps ?? []).map((s) => s.run ?? "").join("\n");
    // A swallowed rollback failure leaves a broken deploy live while the job
    // reports that it rolled back.
    expect(run).not.toMatch(/\|\|\s*echo\s+"Rollback failed/);
    expect(run).toContain(
      "Could not determine the previous production deployment",
    );
  });

  it("resolves the smoke secret before scripts/deploy ships code", () => {
    const source = readFileSync("scripts/deploy", "utf8");
    const guard = source.indexOf("./scripts/secret CRON_SECRET");
    const deploy = source.indexOf("vercel deploy --prod");
    expect(guard).toBeGreaterThan(-1);
    // A deploy that cannot be smoked has to fail before the code is live,
    // not after: on 2026-10-20 a healthy deploy was shipped and then
    // reported as failed, because the secret it smoked with was the
    // redacted placeholder from the pulled env file.
    expect(guard).toBeLessThan(deploy);
  });

  for (const [name, source] of sources) {
    it(`${name} rolls back only when the deployment itself is broken`, () => {
      // The smoke check exits 1 for a broken deployment and 2 for a check
      // that could not run (no usable secret, the secret was rejected, the
      // protection bypass is wrong). A caller that rolls back on any
      // failure reverts a healthy deploy over a credential mistake, which
      // is what the exit-2 code exists to prevent.
      expect(source, name).toMatch(/smoke_status=\$\?/);
      expect(source, name).toMatch(
        /smoke_status=\$\?[\s\S]{0,600}?-eq 1[\s\S]{0,600}?rollback/,
      );
    });
  }

  it("points the test database reset at the test database", () => {
    const source = readFileSync("scripts/reset-test-db", "utf8");
    // prisma.config.ts prefers DATABASE_URL_UNPOOLED, so overriding only
    // DATABASE_URL lets a stray DATABASE_URL_UNPOOLED in the environment
    // point this throwaway reset at another database: a leaked production
    // URL once planned it against prod.
    expect(source).toMatch(
      /DATABASE_URL="\$TEST_DB_URL" DATABASE_URL_UNPOOLED="\$TEST_DB_URL"/,
    );
  });
});
