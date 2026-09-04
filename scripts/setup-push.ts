import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * One-time Fastmail push setup:
 *  1. generates PUSH_PRIVATE_KEY / PUSH_AUTH (RFC 8291 Web Push keys),
 *     writes them to .env, and prints the `vercel env add` commands
 *  2. creates (or renews) the Fastmail push subscription pointing at
 *     <PUBLIC_URL>/api/inbound-push
 *
 * Run it once before deploy, then again after deploy so the PushVerification
 * handshake can reach the live webhook and the subscription becomes verified.
 * The daily cron keeps the subscription renewed afterwards.
 */

function loadEnv(path: string): void {
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      const key = t.slice(0, i).trim();
      const value = t
        .slice(i + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // no .env file, which is fine: env vars may come from the shell
  }
}

function upsertEnv(path: string, updates: Record<string, string>): void {
  let content = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = content.split("\n");
  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    const line = `${key}=${value}`;
    if (idx === -1) lines.push(line);
    else lines[idx] = line;
  }
  writeFileSync(path, `${lines.join("\n").replace(/^\n+/, "")}\n`);
}

async function main(): Promise<void> {
  const envPath = resolve(process.cwd(), ".env");
  loadEnv(envPath);

  if (!process.env.PUSH_PRIVATE_KEY || !process.env.PUSH_AUTH) {
    // Import after the .env load so env.ts (which snapshots env at import
    // time) is not evaluated before we know whether keys already exist.
    const { generatePushKeys } = await import("~/lib/fastmail-push.server");
    const keys = generatePushKeys();
    process.env.PUSH_PRIVATE_KEY = keys.privateKey;
    process.env.PUSH_AUTH = keys.auth;
    upsertEnv(envPath, {
      PUSH_PRIVATE_KEY: keys.privateKey,
      PUSH_AUTH: keys.auth,
    });
    console.info("Generated push keys. Add them to Vercel (production):");
    console.info(
      `  vercel env add PUSH_PRIVATE_KEY ${keys.privateKey} production`,
    );
    console.info(`  vercel env add PUSH_AUTH ${keys.auth} production`);
  }

  // env.ts loads .env on first import, so the keys above are now in place.
  const [{ ensureSubscription, pushUrl }, { FASTMAIL_TOKEN }] =
    await Promise.all([
      import("~/lib/fastmail-push.server"),
      import("~/lib/env"),
    ]);

  if (!FASTMAIL_TOKEN) {
    console.error(
      "FASTMAIL_TOKEN is missing — add it to .env first (Fastmail → Settings → " +
        "Privacy & Security → Integrations → API tokens; full mail access).",
    );
    process.exit(1);
  }
  if (!process.env.PUBLIC_URL) {
    console.warn(
      "PUBLIC_URL is not set — the push endpoint must be publicly reachable. " +
        "Set PUBLIC_URL=https://expense.labnotes.org in .env and Vercel.",
    );
  }

  const id = await ensureSubscription();
  console.info(`Subscription active: ${id}`);
  console.info(`Pushes + verification arrive at ${pushUrl()}`);
  console.info(
    "If this is the first run, deploy first so the verification webhook is " +
      "live, then run `pnpm setup:push` again.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
