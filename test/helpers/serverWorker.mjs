/**
 * Forked server worker: starts the Vite dev server and signals the parent.
 * Run via `fork()` from launchServer.ts with DATA_DIR pointed at a test directory.
 */
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import reactRouter from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

async function startServer() {
  const send = process.send?.bind(process);
  if (!send) throw new Error("process.send is not defined (not forked?)");
  const port = Number(process.env.PORT);
  if (!port) throw new Error("PORT is not defined");

  const testCacheDir = resolve(`node_modules/.vite-test-${port}`);
  await rm(testCacheDir, { recursive: true, force: true });

  const config = defineConfig({
    plugins: [tailwindcss(), reactRouter()],
    resolve: {
      alias: [
        { find: "~", replacement: resolve("app") },
        { find: "+types", replacement: resolve(".react-router/types") },
      ],
    },
    server: {
      port,
      strictPort: true,
      hmr: false,
      watch: null,
    },
    cacheDir: testCacheDir,
    clearScreen: false,
    logLevel: "warn",
    build: { minify: false, sourcemap: true },
    optimizeDeps: {
      entries: ["app/root.tsx", "app/routes/**/*.tsx", "app/routes/**/*.ts"],
      include: [
        "react",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "react-dom/client",
        "react-router",
        "lucide-react",
        "leaflet",
        "csv-parse/sync",
        "csv-stringify/sync",
        "ulid",
        "zod",
        "class-variance-authority",
        "clsx",
        "tailwind-merge",
      ],
    },
  });

  const devServer = await createServer(config);
  await devServer.listen(port);
  devServer.httpServer?.unref();

  async function shutdown() {
    try {
      await devServer?.close();
    } catch {
      // ignore cleanup errors
    }
    await rm(testCacheDir, { recursive: true, force: true }).catch(() => {});
    process.exit(0);
  }

  process.on("message", (msg) => {
    if (msg === "shutdown") void shutdown();
  });
  process.on("disconnect", () => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  send({ type: "ready" });
}

await startServer();
