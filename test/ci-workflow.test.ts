import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
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

interface Job {
  needs?: string | string[];
  if?: string;
  env?: Record<string, string>;
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
