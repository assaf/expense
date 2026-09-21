import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The dark-mode gate (scripts/check-dark-mode.mjs) is the only thing keeping a
 * color class without a `dark:` twin out of the app, and nothing in the suite
 * ran it until now: a one-character regression in its conflict detection or
 * its per-literal coverage scan would ship unreadable dark-mode surfaces. The
 * script reads APP_DIR from the environment, so a fixture tree drives each of
 * its two failure modes and its two false-positive traps without touching app/.
 */

const SCRIPT = fileURLToPath(
  new URL("../scripts/check-dark-mode.mjs", import.meta.url),
);
const FIXTURES = fileURLToPath(
  new URL("./fixtures/dark-mode", import.meta.url),
);

function run(fixture: string) {
  return spawnSync("node", [SCRIPT], {
    env: { ...process.env, APP_DIR: `${FIXTURES}/${fixture}` },
    encoding: "utf8",
  });
}

interface Case {
  fixture: string;
  status: number;
  /** Stream the gate writes on this outcome, and the matcher it must carry. */
  stream: "stdout" | "stderr";
  match: RegExp;
}

const CASES: Case[] = [
  // A well-formed pair passes with the summary line on stdout.
  {
    fixture: "clean",
    status: 0,
    stream: "stdout",
    match: /^pass: every color class/,
  },
  // Failure mode 1: a color class with no dark twin at all.
  {
    fixture: "missing-twin",
    status: 1,
    stream: "stderr",
    match: /without a dark: twin/,
  },
  // Failure mode 2: two dark values for one property in one literal (the
  // quoted-attribute branch).
  {
    fixture: "conflict-quoted",
    status: 1,
    stream: "stderr",
    match: /conflicting dark variants/,
  },
  // The same conflict inside a `className={…}` expression: the branch that
  // replaced the quoted-only matcher, which skipped every expression.
  {
    fixture: "conflict-expression",
    status: 1,
    stream: "stderr",
    match: /conflicting dark variants/,
  },
  // Coverage is per literal: a twin in the other arm of a conditional never
  // applies at runtime, so the untwinned arm must fail.
  {
    fixture: "cross-branch",
    status: 1,
    stream: "stderr",
    match: /without a dark: twin/,
  },
  // Exemptions are judged on the whole token, so a variant form of a
  // theme-exempt status color (`hover:text-red-600`) still needs its twin.
  {
    fixture: "hover-status",
    status: 1,
    stream: "stderr",
    match: /without a dark: twin/,
  },
  // False-positive trap: ring-offset is keyed as its own property, so its
  // dark twin is not read as a conflict with ring-blue-400.
  {
    fixture: "ring-offset-ok",
    status: 0,
    stream: "stdout",
    match: /^pass: every color class/,
  },
  // False-positive trap: mutually exclusive dark arms are not a conflict.
  {
    fixture: "ternary-ok",
    status: 0,
    stream: "stdout",
    match: /^pass: every color class/,
  },
];

describe("dark-mode gate", () => {
  it.each(CASES)(
    "$fixture -> status $status",
    ({ fixture, status, stream, match }) => {
      const result = run(fixture);
      expect(result.status).toBe(status);
      expect(result[stream]).toMatch(match);
    },
  );
});
