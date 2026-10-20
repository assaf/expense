/**
 * Launch the test server as a child process.
 * Builds the app first if needed (so `vp test` works standalone),
 * spawns react-router-serve, and polls the port until ready.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, globSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

let serverProcess: ChildProcess | undefined;
let mockJmap: Server | undefined;

/**
 * Local mock of Fastmail's JMAP session endpoint, so browser tests can
 * drive the connect and onboarding flows without the spawned server ever
 * reaching api.fastmail.com (the suite forbids outbound network). Any
 * Bearer token verifies; the username is derived from the token so each
 * test gets a distinct mailbox address. Every other path 404s, so a stray
 * drain fails fast locally instead of hanging.
 */
async function startMockJmap(): Promise<string> {
  const server = createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    if (req.url === "/jmap/session" && auth.startsWith("Bearer ")) {
      const suffix =
        auth
          .slice(7)
          .replace(/[^a-zA-Z0-9]/g, "")
          .slice(-8) || "default";
      // Same-origin endpoints, like a real server: the session document is
      // authoritative for these URLs and a cross-host one is refused (the
      // mock answered with a placeholder port 9 before, which no longer
      // reads as a JMAP session).
      const host = req.headers.host ?? "127.0.0.1";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          username: `mock-${suffix}@fastmail.test`,
          apiUrl: `http://${host}/jmap/api`,
          uploadUrl: `http://${host}/jmap/upload`,
          downloadUrl: `http://${host}/jmap/download`,
          primaryAccounts: { "urn:ietf:params:jmap:mail": "mock-mail-acct" },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock JMAP server did not bind a port");
  }
  mockJmap = server;
  return `http://127.0.0.1:${address.port}`;
}

let serverPort = 5199;

/**
 * The suite must never report to the production Sentry project.
 *
 * A developer's shell can carry Vercel's own variables: `vercel env pull`
 * writes VERCEL_ENV=production, SENTRY_DSN and the rest into .env.prod,
 * and sourcing that file (or inheriting a shell that had it) puts them in
 * the environment. The app's Sentry init reads exactly those, so a local
 * test run reported the suite's deliberately provoked errors into the live
 * project — six issues on 2026-10-20, tagged environment=production. The
 * build needs the same treatment: VITE_SENTRY_DSN is inlined into the
 * client bundle at build time, so the test browser would report too.
 */
const NO_REPORTING = {
  VERCEL_ENV: "test",
  SENTRY_DSN: "",
  VITE_SENTRY_DSN: "",
  SENTRY_AUTH_TOKEN: "",
} as const;

/** The PID holding the port, or undefined when it is free (or lsof cannot
 * tell us — CI containers without it just skip the check). */
function squatterPidOn(port: number): number | undefined {
  try {
    const out = execFileSync("lsof", ["-ti", `:${port}`], {
      encoding: "utf8",
    });
    const pid = Number(out.trim().split("\n")[0]);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

export async function launchServer(): Promise<string> {
  // Fail fast on a squatted port: several suites hardcode 5199, so
  // silently shifting to 5200 would point them at a leftover server
  // running against a schema this setup is about to drop — dozens of
  // failures with assertions that have nothing to do with the cause.
  const squatter = squatterPidOn(serverPort);
  if (squatter !== undefined) {
    throw new Error(
      `Port ${serverPort} is already held by PID ${squatter} — a leftover ` +
        "test server from an interrupted run. Kill it and re-run: " +
        `lsof -ti :${serverPort} | xargs kill`,
    );
  }
  await ensureBuild();
  await findAvailablePort();
  const jmapBase = await startMockJmap();
  const env = {
    ...process.env,
    ...NO_REPORTING,
    NODE_ENV: "test",
    PORT: String(serverPort),
    HOSTNAME: "127.0.0.1",
    DATABASE_URL: "postgres://assaf@localhost/expense_test",
    // Pins the home page's "Did you know?" highlight pick (see
    // _index.tsx): the rotation would otherwise change home's render
    // between screenshot runs and flag phantom drift.
    SCREENSHOT_HIGHLIGHT_PIN: "1",
    // Fixed key (same value as vitest.main.config.ts `test.env`) so the Email
    // page renders the connected-accounts UI deterministically. The spawned
    // server doesn't inherit vitest's test.env (globalSetup runs in the main
    // process), and CI has no .env, so without this the section would show
    // "not configured" there and "configured" locally.
    EMAIL_TOKEN_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
    // PUBLIC_URL would otherwise leak from .env into the test server and
    // change the OAuth metadata issuer to the production origin; tests
    // assert on the request/forwarded origin instead.
    PUBLIC_URL: "",
    // Dummy Gmail config so the Email page renders the "Connect with
    // Gmail" button deterministically (same reasoning as the key above;
    // real consent can't complete in tests, which is fine: the unit tests
    // cover the callback against mocked endpoints).
    GOOGLE_OAUTH_CLIENT_ID: "test-gmail-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "test-gmail-client-secret",
    GOOGLE_PUBSUB_TOPIC: "projects/test/topics/expense-test",
    // Same for the Fastmail OAuth button (public PKCE client, no secret).
    FASTMAIL_OAUTH_CLIENT_ID: "test-fm-client-id",
    // Point the user-token JMAP client at the local mock (see
    // startMockJmap) so connect and onboarding flows stay offline.
    JMAP_SESSION_URL: `${jmapBase}/jmap/session`,
    // Pin the server's clock to the suite-wide pinned instant (see
    // pinned-clock.mjs / frozen-time.ts) so server-computed "today" matches
    // the frozen test and browser clocks.
    NODE_OPTIONS: "--import ./test/helpers/pinned-clock.mjs",
  };

  serverProcess = spawn("pnpm", ["start"], {
    cwd: resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
    env,
    // `pnpm start` runs the server through a shell, so signalling the pnpm
    // child alone leaves the actual node server orphaned and reparented to
    // launchd on every run. A process group lets closeServer signal the
    // whole tree.
    detached: true,
  });

  serverProcess.stdout?.on("data", (_data: Buffer) => {
    // ignore
  });
  serverProcess.stderr?.on("data", (_data: Buffer) => {
    // print for debugging
  });

  // Wait for the server to be ready by polling the port. Uses
  // performance.now() because the test-process Date is frozen by the suite
  // and Date.now() would never advance past the deadline.
  const baseURL = `http://127.0.0.1:${serverPort}`;
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline) {
    try {
      const res = await fetch(`${baseURL}/`);
      if (res.ok || res.status === 404) {
        return baseURL;
      }
    } catch {
      // not ready yet
    }
    await sleep(500);
  }
  throw new Error("Server startup timeout after 60s");
}

/**
 * Build the app if build/server/index.js is missing or older than the newest
 * source file. Keeps `vp test` self-sufficient without slowing re-runs.
 */
async function ensureBuild(): Promise<void> {
  const buildPath = resolve("build/server/index.js");
  const buildMtime = existsSync(buildPath) ? statSync(buildPath).mtimeMs : 0;
  const newestSource = newestMtime([
    "app",
    "react-router.config.ts",
    "vite.config.ts",
    "tsconfig.json",
  ]);
  if (buildMtime > 0 && buildMtime >= newestSource) return;

  console.info("Building app for tests…");
  await run("pnpm", ["exec", "react-router", "build", "--force"], {
    ...process.env,
    ...NO_REPORTING,
  });
}

function newestMtime(paths: string[]): number {
  let newest = 0;
  // A symlinked source is still a build input, so follow links like statSync.
  const patterns = paths.flatMap((p) => [p, `${p}/**/*`]);
  for (const p of globSync(patterns, { followSymlinks: true })) {
    const st = statSync(p);
    if (st.isFile()) newest = Math.max(newest, st.mtimeMs);
  }
  return newest;
}

function run(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: resolve("."),
      stdio: "inherit",
      env,
    });
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

export async function closeServer(): Promise<void> {
  const child = serverProcess;
  serverProcess = undefined;
  if (child?.pid !== undefined) {
    const pid = child.pid;
    const exited = new Promise<void>((resolveExit) => {
      if (child.exitCode !== null || child.signalCode !== null) resolveExit();
      else child.once("exit", () => resolveExit());
    });
    signalGroup(pid, "SIGTERM");
    // `exited` only reports the pnpm wrapper; wait on it, then force the
    // group down if it did not take the signal.
    await Promise.race([exited, sleep(5000)]);
    if (child.exitCode === null && child.signalCode === null) {
      signalGroup(pid, "SIGKILL");
    }
  }
  mockJmap?.close();
  mockJmap = undefined;
}

/** Signal a detached child's whole process group; ignore a group that is
 * already gone. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
}

async function findAvailablePort() {
  while (!(await isPortAvailable(serverPort))) serverPort++;
}

async function isPortAvailable(port: number): Promise<boolean> {
  const net = await import("net");
  return new Promise<boolean>((resolve) => {
    const tester = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => tester.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });
}
