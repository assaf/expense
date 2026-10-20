import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * The deploy tooling decides whether a broken deploy stays live, and both of
 * its two load-bearing rules are invisible in the code that uses them:
 *
 *  - the smoke check sends a secret, and a secret that is the literal
 *    `[SENSITIVE]` (what `vercel env pull` writes for a sensitive var) is not
 *    a value: the route rejects it and answers a 404 that reads like a
 *    broken deployment. On 2026-10-20 a healthy deploy was reported as
 *    failed for exactly that reason, and the message said "network/HTTP";
 *  - `vercel rollback <target>` makes <target> the production deployment, so
 *    rolling back to the deployment that just failed is a no-op Vercel
 *    refuses (422). The safety net failed without failing visibly.
 *
 * These run the scripts the way their callers run them.
 */

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(
  script: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; stdin?: string } = {},
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("bash", [resolve(script), ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...options.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => {
      resolvePromise({ status, stdout, stderr });
    });
    // Always close stdin: a script that reads it (--from-stdin) needs the
    // data, and one that does not must not wait for an EOF that never comes.
    child.stdin.end(options.stdin ?? "");
  });
}

/** A directory with no .env in it, so the scripts fall back to the
 * environment only. */
function emptyDir(): string {
  return mkdtempSync(join(tmpdir(), "expense-deploy-"));
}

function dirWithEnv(contents: string): string {
  const dir = emptyDir();
  writeFileSync(join(dir, ".env"), contents);
  return dir;
}

describe("scripts/secret", () => {
  it("refuses the redaction placeholder: a redacted value is not a value", async () => {
    const result = await run("scripts/secret", ["TEST_SECRET"], {
      env: { TEST_SECRET: "[SENSITIVE]" },
      cwd: emptyDir(),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("TEST_SECRET");
    expect(result.stderr).toContain("not a value");
    expect(result.stdout).toBe("");
  });

  it("falls back to the local .env when the environment has no value", async () => {
    const result = await run("scripts/secret", ["TEST_SECRET"], {
      env: { TEST_SECRET: "[SENSITIVE]" },
      cwd: dirWithEnv("TEST_SECRET=the-real-value\n"),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("the-real-value");
  });

  it("prefers the environment over the .env file", async () => {
    const result = await run("scripts/secret", ["TEST_SECRET"], {
      env: { TEST_SECRET: "from-the-environment" },
      cwd: dirWithEnv("TEST_SECRET=from-the-file\n"),
    });
    expect(result.stdout).toBe("from-the-environment");
  });

  it("unwraps a quoted value", async () => {
    const result = await run("scripts/secret", ["TEST_SECRET"], {
      cwd: dirWithEnv('TEST_SECRET="the-real-value"\n'),
    });
    expect(result.stdout).toBe("the-real-value");
  });

  it("reports a name it cannot resolve at all", async () => {
    const result = await run("scripts/secret", ["TEST_SECRET"], {
      cwd: emptyDir(),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("TEST_SECRET is not set");
  });
});

describe("scripts/smoke-check", () => {
  /** A stand-in for the deployed app's smoke route. `requests` counts the
   * calls that reached it, so a test can prove the script gave up before
   * making one. */
  async function withSmokeRoute(
    handler: (url: string) => { status: number; body: unknown },
  ): Promise<{ url: string; requests: string[]; close: () => Promise<void> }> {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      const { status, body } = handler(req.url ?? "");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      requests,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  it("passes on a healthy deployment", async () => {
    const route = await withSmokeRoute(() => ({
      status: 200,
      body: {
        ok: true,
        pdfText: "SMOKE RECEIPT",
        ocrText: "SMOKE RECEIPT",
        mcp: { tools: 13 },
        sentryInitialized: true,
        ms: 12,
      },
    }));
    try {
      const result = await run("scripts/smoke-check", [route.url], {
        env: { CRON_SECRET: "the-real-secret", ENV_FILE: "/nonexistent" },
        cwd: emptyDir(),
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("PDF + OCR OK");
    } finally {
      await route.close();
    }
  });

  it("names the secret as the cause when the route answers its deliberate 404", async () => {
    const route = await withSmokeRoute(() => ({
      status: 404,
      body: { error: "Not found" },
    }));
    try {
      const result = await run("scripts/smoke-check", [route.url], {
        env: { CRON_SECRET: "the-wrong-secret", ENV_FILE: "/nonexistent" },
        cwd: emptyDir(),
      });
      // Exit 2, not 1: the check could not run, so the deployment may be
      // fine and the caller must not roll it back.
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("404");
      expect(result.stderr).toContain(
        "the secret is wrong, not the deployment",
      );
    } finally {
      await route.close();
    }
  });

  it("names a broken deployment when the route answers a server error", async () => {
    // 501, not 500: curl's --retry list covers 500/502/503/504, and waiting
    // out three retries with a 5s delay would blow the test timeout.
    const route = await withSmokeRoute(() => ({
      status: 501,
      body: { error: "boom" },
    }));
    try {
      const result = await run("scripts/smoke-check", [route.url], {
        env: { CRON_SECRET: "the-real-secret", ENV_FILE: "/nonexistent" },
        cwd: emptyDir(),
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("the deployment is broken");
    } finally {
      await route.close();
    }
  });

  it("gives up before making a request when the secret is unusable", async () => {
    const route = await withSmokeRoute(() => ({
      status: 200,
      body: { ok: true },
    }));
    try {
      const result = await run("scripts/smoke-check", [route.url], {
        env: { CRON_SECRET: "[SENSITIVE]", ENV_FILE: "/nonexistent" },
        cwd: emptyDir(),
      });
      // Exit 2: nothing was checked, so there is nothing to roll back.
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("CRON_SECRET");
      expect(result.stderr).not.toContain("network error");
      expect(route.requests).toEqual([]);
    } finally {
      await route.close();
    }
  });

  it("calls a 404 that is not the gate a broken deployment", async () => {
    const route = await withSmokeRoute(() => ({
      status: 404,
      body: { error: "This route does not exist" },
    }));
    try {
      const result = await run("scripts/smoke-check", [route.url], {
        env: { CRON_SECRET: "the-real-secret", ENV_FILE: "/nonexistent" },
        cwd: emptyDir(),
      });
      expect(result.status).toBe(1);
    } finally {
      await route.close();
    }
  });

  it(
    "calls a deployment it cannot reach a broken deployment",
    async () => {
      // Nothing listens on this port: the deployment is down, which is a
      // broken deployment, not a check that could not run.
      const result = await run("scripts/smoke-check", ["http://127.0.0.1:1"], {
        env: { CRON_SECRET: "the-real-secret", ENV_FILE: "/nonexistent" },
        cwd: emptyDir(),
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("could not reach");
    },
    // curl retries a refused connection three times with a 5s delay
    // (--retry 3 --retry-delay 5 --retry-connrefused), so this one is slow
    // by construction.
    30_000,
  );
});

describe("scripts/previous-deployment", () => {
  const LIST = {
    deployments: [
      {
        url: "expense-new-assafs-projects-a315fe37.vercel.app",
        name: "expense",
        state: "READY",
        target: "production",
        createdAt: 3000,
      },
      {
        url: "expense-prev-assafs-projects-a315fe37.vercel.app",
        name: "expense",
        state: "READY",
        target: "production",
        createdAt: 2000,
      },
      {
        url: "expense-preview-abc123.vercel.app",
        name: "expense",
        state: "READY",
        target: "preview",
        createdAt: 2500,
      },
      {
        url: "expense-old-assafs-projects-a315fe37.vercel.app",
        name: "expense",
        state: "READY",
        target: "production",
        createdAt: 1000,
      },
    ],
  };

  it("picks the production deployment that was live before the failed one", async () => {
    const result = await run(
      "scripts/previous-deployment",
      [
        "--from-stdin",
        "https://expense-new-assafs-projects-a315fe37.vercel.app",
      ],
      { stdin: JSON.stringify(LIST) },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      "https://expense-prev-assafs-projects-a315fe37.vercel.app",
    );
  });

  it("skips a production deployment that is not READY", async () => {
    const list = {
      deployments: [
        {
          url: "expense-new.vercel.app",
          state: "BUILDING",
          target: "production",
          createdAt: 4000,
        },
        ...LIST.deployments,
      ],
    };
    const result = await run(
      "scripts/previous-deployment",
      [
        "--from-stdin",
        "https://expense-new-assafs-projects-a315fe37.vercel.app",
      ],
      { stdin: JSON.stringify(list) },
    );
    expect(result.stdout.trim()).toBe(
      "https://expense-prev-assafs-projects-a315fe37.vercel.app",
    );
  });

  it("fails when there is no earlier production deployment", async () => {
    const only = {
      deployments: [LIST.deployments[0]!],
    };
    const result = await run(
      "scripts/previous-deployment",
      [
        "--from-stdin",
        "https://expense-new-assafs-projects-a315fe37.vercel.app",
      ],
      { stdin: JSON.stringify(only) },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No earlier production deployment");
  });

  it("skips the deployment just made when the failed URL is the production alias", async () => {
    // The deploy script falls back to the production alias when it cannot
    // read the deployment URL out of the CLI output, and the alias is not a
    // deployment in the list. The newest entry is the deployment that was
    // just made, so the target is the second newest.
    const result = await run(
      "scripts/previous-deployment",
      ["--from-stdin", "https://expense.labnotes.org"],
      { stdin: JSON.stringify(LIST) },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      "https://expense-prev-assafs-projects-a315fe37.vercel.app",
    );
  });

  it("does not depend on the order the list arrives in", async () => {
    const scrambled = {
      deployments: [
        LIST.deployments[3]!,
        LIST.deployments[1]!,
        LIST.deployments[0]!,
        LIST.deployments[2]!,
      ],
    };
    const result = await run(
      "scripts/previous-deployment",
      [
        "--from-stdin",
        "https://expense-new-assafs-projects-a315fe37.vercel.app",
      ],
      { stdin: JSON.stringify(scrambled) },
    );
    expect(result.stdout.trim()).toBe(
      "https://expense-prev-assafs-projects-a315fe37.vercel.app",
    );
  });

  it("fails when the deployment list cannot be read", async () => {
    const result = await run(
      "scripts/previous-deployment",
      [
        "--from-stdin",
        "https://expense-new-assafs-projects-a315fe37.vercel.app",
      ],
      { stdin: "not json" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Could not read the Vercel deployment list",
    );
  });
});
