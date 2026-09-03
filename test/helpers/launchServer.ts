/**
 * Launch the test server as a child process.
 * Builds the app first if needed (so `vp test` works standalone),
 * spawns react-router-serve, and polls the port until ready.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, statSync } from "node:fs";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

let serverProcess: ChildProcess | undefined;
let mockJmap: Server | undefined;

/**
 * Local mock of FastMail's JMAP session endpoint, so browser tests can
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
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          username: `mock-${suffix}@fastmail.test`,
          apiUrl: "http://127.0.0.1:9/jmap/api",
          uploadUrl: "http://127.0.0.1:9/jmap/upload",
          downloadUrl: "http://127.0.0.1:9/jmap/download",
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

export async function launchServer(): Promise<string> {
  await ensureBuild();
  await findAvailablePort();
  const jmapBase = await startMockJmap();
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(serverPort),
    HOSTNAME: "127.0.0.1",
    DATABASE_URL: "postgres://assaf@localhost/expense_test",
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
    // Same for the FastMail OAuth button (public PKCE client, no secret).
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
  await run("pnpm", ["exec", "react-router", "build", "--force"]);
}

function newestMtime(paths: string[]): number {
  let newest = 0;
  const visit = (p: string) => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const child of readdirSync(p)) visit(resolve(p, child));
    } else {
      newest = Math.max(newest, st.mtimeMs);
    }
  };
  for (const p of paths) visit(resolve(p));
  return newest;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd: resolve("."), stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

export async function closeServer(): Promise<void> {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    await sleep(3000);
    if (serverProcess?.killed === false) serverProcess.kill("SIGKILL");
    serverProcess = undefined;
  }
  mockJmap?.close();
  mockJmap = undefined;
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
