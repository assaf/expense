/**
 * Launch the test server as a child process.
 * Use spawn for react-router-serve, poll the port until ready.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

let serverProcess: ChildProcess | undefined;
let serverPort = 5199;

export async function launchServer(): Promise<string> {
  await findAvailablePort();
  const env = {
    ...process.env,
    DATA_DIR: "data-test",
    NODE_ENV: "test",
    PORT: String(serverPort),
    HOSTNAME: "127.0.0.1",
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
