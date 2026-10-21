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
  user: {
    id: "user_share_test",
    accountId: "",
    email: "share@example.com",
    emailVerifiedAt: null,
    credentialsChangedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
}));

vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return {
    ...actual,
    // requireContextUser is SYNC (it returns the user, or throws the login
    // redirect). An async mock here hands the route a Promise, so
    // `user.accountId` reads as undefined and the receipt is filed with a
    // null accountId.
    requireContextUser: vi.fn(() => mocks.user),
  };
});

vi.mock("~/lib/receipt-ocr.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/lib/receipt-ocr.server")>();
  return {
    ...actual,
    // The real extraction hands back the picture it was given (rasterized
    // for a PDF). Echoing the buffer the caller passed keeps the stored
    // bytes traceable to the shared photo, so the blob assertion below
    // checks what was actually filed rather than a stub's placeholder.
    extractFromImage: vi.fn(
      async ({ buffer, mime }: { buffer: Buffer; mime: string }) => ({
        result: {
          isReceipt: true,
          merchant: "Blue Bottle",
          amount: "6.50",
          currency: "USD",
          category: "Meals",
          confidence: "high",
          notes: "",
        },
        text: "",
        stored: { buffer, mime },
      }),
    ),
  };
});

import { action } from "~/routes/api.share-receipt";
import { normalizeStoredImage } from "~/lib/image-normalize";
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
    // The image came with it: the expense points at a blob, and that blob
    // holds the shared photo's bytes (not an empty placeholder).
    expect(row?.imageFile).toBeTruthy();
    const blob = await testPrisma.imageBlob.findFirst({
      where: { accountId: TEST_ACCOUNT_ID, key: row?.imageFile ?? "" },
      select: { data: true, mime: true, sha256: true },
    });
    expect(blob).not.toBeNull();
    const stored = Buffer.from(blob!.data as Uint8Array);
    expect(stored.length).toBeGreaterThan(0);
    // The store normalizes what it keeps (a raster image is re-encoded as
    // JPEG), so the bytes to compare against are the same photo after the
    // app's own normalization — not the PNG as it was shared.
    const normalized = await normalizeStoredImage(TINY_PNG);
    expect(normalized).not.toBeNull();
    expect(stored.equals(normalized!.buffer)).toBe(true);
    expect(blob!.mime).toBe(normalized!.mime);
    // The expense's fingerprint is the blob's fingerprint: the row and the
    // bytes are the same file.
    expect(row?.imageSha256).toBe(blob!.sha256);
  });
});
