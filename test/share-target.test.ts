import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";

/**
 * The PWA share target: the manifest points a shared photo at
 * /api/share-receipt, and the POST that lands there becomes an expense.
 * The extraction is stubbed here (it is the LLM pipeline, covered by
 * receipt-ai.test.ts); what this pins is the plumbing — the shared file
 * becomes a filed expense with the image attached.
 */

const mocks = vi.hoisted(() => ({
  user: { accountId: "" },
}));

vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return {
    ...actual,
    requireContextUser: vi.fn(async () => mocks.user),
  };
});

vi.mock("~/lib/receipt-ocr.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/lib/receipt-ocr.server")>();
  return {
    ...actual,
    extractFromImage: vi.fn(async () => ({
      result: {
        isReceipt: true,
        merchant: "Blue Bottle",
        amount: "6.50",
        currency: "USD",
        category: "Meals",
        confidence: "high",
        notes: "",
      },
      stored: { buffer: Buffer.alloc(0), mime: "image/png" },
    })),
  };
});

import { action } from "~/routes/api.share-receipt";
import { TEST_ACCOUNT_ID, testPrisma } from "./helpers/seedTestData";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function args(request: Request): Parameters<typeof action>[0] {
  return {
    request,
    url: new URL(request.url),
    params: {},
    pattern: "api/share-receipt",
    context: {} as never,
  };
}

describe("the PWA share target", () => {
  it("declares the share target in the manifest", () => {
    const manifest = JSON.parse(
      readFileSync("public/manifest.json", "utf8"),
    ) as {
      share_target?: {
        action: string;
        method: string;
        enctype: string;
        params?: { files?: Array<{ name: string; accept: string[] }> };
      };
    };

    expect(manifest.share_target?.action).toBe("/api/share-receipt");
    expect(manifest.share_target?.method).toBe("POST");
    expect(manifest.share_target?.enctype).toBe("multipart/form-data");
    // The file field is the one the upload reader looks for.
    expect(manifest.share_target?.params?.files?.[0]?.name).toBe("file");
  });

  it("files a shared photo as an expense and opens it", async () => {
    mocks.user.accountId = TEST_ACCOUNT_ID;
    const form = new FormData();
    form.set(
      "file",
      new File([TINY_PNG], "receipt.png", { type: "image/png" }),
    );
    form.set("text", "coffee with Sam");

    const before = await testPrisma.expense.count({
      where: { accountId: TEST_ACCOUNT_ID },
    });

    const res = await action(
      args(
        new Request("https://expense.test/api/share-receipt", {
          method: "POST",
          body: form,
        }),
      ),
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toMatch(/^\/expense\/\w+$/);

    const after = await testPrisma.expense.count({
      where: { accountId: TEST_ACCOUNT_ID },
    });
    expect(after).toBe(before + 1);

    const id = location.split("/").pop() as string;
    const row = await testPrisma.expense.findFirst({
      where: { id, accountId: TEST_ACCOUNT_ID },
    });
    expect(row).toBeTruthy();
    expect(row?.merchant).toBe("Blue Bottle");
    expect(row?.amount).toBe("6.50");
    // The share sheet's text is the note the receipt needed.
    expect(row?.description).toContain("coffee with Sam");
    // The image came with it.
    expect(row?.imageFile).toBeTruthy();
  });
});
