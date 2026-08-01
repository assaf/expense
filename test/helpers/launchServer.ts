/**
 * Launch the test server as a child process.
 * Builds the app first if needed (so `vp test` works standalone),
 * spawns react-router-serve, and polls the port until ready.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

let serverProcess: ChildProcess | undefined;
let serverPort = 5199;

export async function launchServer(): Promise<string> {
  await ensureBuild();
  await findAvailablePort();
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(serverPort),
    HOSTNAME: "127.0.0.1",
    DATABASE_URL: "postgres://assaf@localhost/expensify_test",
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

  // Wait for the server to be ready by polling the port
  const baseURL = `http://127.0.0.1:${serverPort}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseURL}/`);
      if (res.ok || res.status === 404) {
        return baseURL;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
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
    await new Promise((r) => setTimeout(r, 3000));
    if (serverProcess?.killed === false) serverProcess.kill("SIGKILL");
    serverProcess = undefined;
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

function cleanup() {
  void closeServer();
}
process.on("exit", cleanup);
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
