import { hash } from "node:crypto";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";

// Route-level contract for the upload intent's duplicate-bytes paths. The
// DB-level behavior lives in reconcile.test.ts; here the action is invoked
// directly with a stubbed requireIntent so the response shapes the client
// consumes (redirect on draft, 409 + alreadyReconciledAt on completed) are
// pinned without a browser.
const mocks = vi.hoisted(() => ({
  form: new FormData(),
  user: { accountId: "" },
}));

vi.mock("~/lib/route-helpers.server", () => ({
  requireIntent: vi.fn(async () => ({
    user: mocks.user,
    form: mocks.form,
    intent: "upload",
  })),
}));

import { action } from "~/routes/reconcile";
import { TEST_ACCOUNT_ID, testPrisma } from "./helpers/seedTestData";

function args(request: Request): Parameters<typeof action>[0] {
  return {
    request,
    url: new URL(request.url),
    params: {},
    pattern: "reconcile",
    context: {} as never,
  };
}

async function seedRun(status: "draft" | "completed", fileHash: string) {
  const completedAt = status === "completed" ? new Date() : null;
  const id = ulid();
  await testPrisma.reconciliationRun.create({
    data: {
      id,
      accountId: TEST_ACCOUNT_ID,
      fileName: "statement.csv",
      fileHash,
      status,
      rowCount: 1,
      matchedCount: 0,
      createdCount: 0,
      skipped: [],
      data: { rows: [], matches: [], decisions: {} },
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      ...(completedAt ? { completedAt: completedAt.toISOString() } : {}),
    },
  });
  return { id, completedAt };
}

describe("reconcile upload action — duplicate bytes", () => {
  it("refuses re-uploading a completed statement with 409 + the run's timestamp", async () => {
    const bytes = "Date,Description,Amount\n2026-07-01,Coffee,9.99\n";
    const fileHash = hash("sha256", Buffer.from(bytes), "hex");
    const run = await seedRun("completed", fileHash);
    try {
      mocks.user.accountId = TEST_ACCOUNT_ID;
      mocks.form = new FormData();
      mocks.form.set(
        "file",
        new File([bytes], "statement.csv", { type: "text/csv" }),
      );
      const res = await action(
        args(
          new Request("https://expense.test/reconcile", {
            method: "POST",
            body: new FormData(),
          }),
        ),
      );
      expect(res).not.toBeNull();
      expect(res!.status).toBe(409);
      const body = (await res!.json()) as {
        error: string;
        alreadyReconciledAt: string;
      };
      expect(body.error).toBe("This statement was already reconciled.");
      // The client formats this client-side; the wire value must be the
      // same instant that was stored (not a server-rendered local string).
      expect(new Date(body.alreadyReconciledAt).getTime()).toBe(
        run.completedAt!.getTime(),
      );
    } finally {
      await testPrisma.reconciliationRun.deleteMany({ where: { id: run.id } });
    }
  });

  it("redirects an exact re-upload of an open draft to the run", async () => {
    const bytes = "Date,Description,Amount\n2026-07-02,Coffee,4.50\n";
    const fileHash = hash("sha256", Buffer.from(bytes), "hex");
    const run = await seedRun("draft", fileHash);
    try {
      mocks.user.accountId = TEST_ACCOUNT_ID;
      mocks.form = new FormData();
      mocks.form.set(
        "file",
        new File([bytes], "statement.csv", { type: "text/csv" }),
      );
      const res = await action(
        args(
          new Request("https://expense.test/reconcile", {
            method: "POST",
            body: new FormData(),
          }),
        ),
      );
      expect(res).not.toBeNull();
      expect(res!.status).toBe(302);
      expect(res!.headers.get("location")).toBe(`/reconcile?run=${run.id}`);
    } finally {
      await testPrisma.reconciliationRun.deleteMany({ where: { id: run.id } });
    }
  });
});
