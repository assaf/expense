import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { readExpenses } from "~/lib/db/expenses";
import { readReportSummaries } from "~/lib/db/reports";
import {
  deleteWarranty,
  readWarrantiesForExpense,
  readWarranty,
  upsertWarranty,
} from "~/lib/db/warranties";
import { deleteImage, readImage } from "~/lib/images.server";
import {
  createWarrantyFromDocument,
  saveWarrantyFromForm,
} from "~/lib/warranty-save.server";
import {
  OTHER_ACCOUNT_ID,
  TEST_ACCOUNT_ID,
  testPrisma,
} from "./helpers/seedTestData";

/** A small valid PNG: sharp decodes it, so the store normalizes and
 * re-encodes it as its own stored mime. */
async function tinyPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 40,
      height: 20,
      channels: 3,
      background: { r: 240, g: 240, b: 240 },
    },
  })
    .png()
    .toBuffer();
}

/** A one-page PDF with a real text layer. */
function tinyPdf(text: string): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const chunks: Buffer[] = [];
  const doc = new PDFDocument({ size: "LETTER" });
  doc.on("data", (c: Buffer) => chunks.push(c));
  doc.on("end", () => resolve(Buffer.concat(chunks)));
  doc.on("error", reject);
  doc.fontSize(12).text(text);
  doc.end();
  return promise;
}

/** A stub chat-completions reply carrying `content`. */
function completionReply(content: string): () => Promise<Response> {
  return async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
    });
}

/** A drop-shaped form: the one file the warranty is read from. */
function documentForm(
  bytes: Buffer | Uint8Array,
  name: string,
  type: string,
): FormData {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], name, { type }));
  return form;
}

interface UploadFixture {
  name: string;
  type: string;
  bytes: Buffer;
  label?: string;
}

/** A warranty save form, the shape the editor posts: scalar fields plus the
 * `documents` files and their parallel `documentLabels`. */
function warrantyForm(
  fields: Record<string, string>,
  files: UploadFixture[] = [],
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  for (const file of files) {
    form.append(
      "documents",
      new File([new Uint8Array(file.bytes)], file.name, { type: file.type }),
    );
    form.append("documentLabels", file.label ?? "Document");
  }
  return form;
}

/** Save a warranty through the real save path and return its id. */
async function save(
  fields: Record<string, string>,
  files: UploadFixture[] = [],
): Promise<string> {
  const result = await saveWarrantyFromForm(
    warrantyForm(fields, files),
    TEST_ACCOUNT_ID,
    null,
  );
  if (result.error !== null) {
    throw new Error(`unexpected save error: ${result.error}`);
  }
  return result.id;
}

// The file reseeds per file, but leaving rows behind would blur this file's
// own later assertions; drop them (and their blobs) on the way out.
afterAll(async () => {
  const rows = await testPrisma.warranty.findMany({
    where: { accountId: TEST_ACCOUNT_ID },
  });
  for (const row of rows) {
    await deleteWarranty(String(row.id), TEST_ACCOUNT_ID);
  }
  await testPrisma.receiptExtraction.deleteMany({
    where: { accountId: TEST_ACCOUNT_ID },
  });
});

// Each extraction test stubs the provider; a leftover stub would let a later
// test pass without its own reply.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("warranty records", () => {
  it("saves a warranty and reads it back inside its own account", async () => {
    const id = await save({
      merchant: "Williams Sonoma",
      product: "Espresso machine",
      value: "1299",
      purchasedAt: "2026-02-01",
      expiresAt: "2028-02-01",
      terms: "Two years parts and labor.",
    });

    const saved = await readWarranty(id, TEST_ACCOUNT_ID);
    expect(saved?.merchant).toBe("Williams Sonoma");
    expect(saved?.product).toBe("Espresso machine");
    // The value is normalized to the column's scale, like every amount.
    expect(saved?.value).toBe("1299.00");
    expect(saved?.purchasedAt).toBe("2026-02-01");
    expect(saved?.expiresAt).toBe("2028-02-01");
    expect(saved?.terms).toBe("Two years parts and labor.");
    expect(saved?.documents).toEqual([]);
    expect(saved?.expenseId).toBe("");

    // Another account cannot read it, and cannot delete it either.
    expect(await readWarranty(id, OTHER_ACCOUNT_ID)).toBeUndefined();
    await deleteWarranty(id, OTHER_ACCOUNT_ID);
    expect(await readWarranty(id, TEST_ACCOUNT_ID)).toBeDefined();
  });

  it("needs a product, and nothing else", async () => {
    const noProduct = await saveWarrantyFromForm(
      warrantyForm({ merchant: "Walgreens" }),
      TEST_ACCOUNT_ID,
      null,
    );
    expect(noProduct).toEqual({
      error: "A warranty needs a product.",
      id: null,
    });

    // The merchant may be unknown: a document dropped on the list page often
    // names the product and the terms but not the seller.
    const noMerchant = await saveWarrantyFromForm(
      warrantyForm({ product: "Toothbrush" }),
      TEST_ACCOUNT_ID,
      null,
    );
    if (noMerchant.error !== null) throw new Error(noMerchant.error);
    expect((await readWarranty(noMerchant.id, TEST_ACCOUNT_ID))?.merchant).toBe(
      "",
    );
  });

  it("refuses a value the money column cannot hold", async () => {
    const before = await testPrisma.warranty.count({
      where: { accountId: TEST_ACCOUNT_ID },
    });
    const result = await saveWarrantyFromForm(
      warrantyForm({
        merchant: "Home Depot",
        product: "Refrigerator",
        value: "99999999999",
      }),
      TEST_ACCOUNT_ID,
      null,
    );
    expect(result.error).toBe("That value is too large to save.");
    expect(result.id).toBeNull();
    expect(
      await testPrisma.warranty.count({
        where: { accountId: TEST_ACCOUNT_ID },
      }),
    ).toBe(before);
  });

  it("stores documents, serves their blobs, and drops them with the record", async () => {
    const id = await save(
      { merchant: "Best Buy", product: "Cordless drill", value: "149.99" },
      [
        {
          name: "receipt.png",
          type: "image/png",
          bytes: await tinyPng(),
          label: "Receipt",
        },
        {
          name: "terms.pdf",
          type: "application/pdf",
          bytes: Buffer.from("%PDF-1.4 terms and conditions"),
          label: "Terms",
        },
      ],
    );

    const saved = await readWarranty(id, TEST_ACCOUNT_ID);
    expect(saved?.documents.map((d) => d.label)).toEqual(["Receipt", "Terms"]);
    expect(saved?.documents.map((d) => d.name)).toEqual([
      "receipt.png",
      "terms.pdf",
    ]);
    const keys = saved!.documents.map((d) => d.key);
    for (const key of keys) {
      expect(await readImage(TEST_ACCOUNT_ID, key)).not.toBeNull();
      // The blobs are namespaced per account: the other account sees nothing.
      expect(await readImage(OTHER_ACCOUNT_ID, key)).toBeNull();
    }
    // A PDF is stored as-is (undecodable bytes pass through the normalizer).
    expect((await readImage(TEST_ACCOUNT_ID, keys[1]!))?.mime).toBe(
      "application/pdf",
    );

    // Remove one document the way the edit route does: rewrite the array
    // first, then drop the blob.
    const remaining = saved!.documents.filter((d) => d.label !== "Terms");
    await upsertWarranty(
      { ...saved!, documents: remaining, updatedAt: new Date().toISOString() },
      TEST_ACCOUNT_ID,
    );
    await deleteImage(TEST_ACCOUNT_ID, keys[1]!);
    const afterRemoval = await readWarranty(id, TEST_ACCOUNT_ID);
    expect(afterRemoval?.documents).toHaveLength(1);
    expect(await readImage(TEST_ACCOUNT_ID, keys[1]!)).toBeNull();

    // Deleting the record drops the documents it still names.
    await deleteWarranty(id, TEST_ACCOUNT_ID);
    expect(await readWarranty(id, TEST_ACCOUNT_ID)).toBeUndefined();
    expect(await readImage(TEST_ACCOUNT_ID, keys[0]!)).toBeNull();
  });

  it("links to an existing expense and silently unlinks a stale id", async () => {
    const row = await testPrisma.expense.findFirst({
      where: { accountId: TEST_ACCOUNT_ID, merchant: "Test Store" },
    });
    expect(row).not.toBeNull();
    const expenseId = String(row!.id);

    const id = await save({
      merchant: "Test Store",
      product: "Espresso machine",
      value: "42.50",
      expenseId,
    });
    const linked = await readWarrantiesForExpense(TEST_ACCOUNT_ID, expenseId);
    expect(linked.map((w) => w.id)).toEqual([id]);

    // An id that names no expense in this account falls back to unlinked
    // rather than failing a save whose other fields are fine.
    const orphanId = await save({
      merchant: "Somewhere",
      product: "Lamp",
      expenseId: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
    });
    expect((await readWarranty(orphanId, TEST_ACCOUNT_ID))?.expenseId).toBe("");
    // Nothing leaked into the other account's rows either.
    expect(await readWarrantiesForExpense(OTHER_ACCOUNT_ID, expenseId)).toEqual(
      [],
    );
  });

  it("stays out of the tax surfaces", async () => {
    const expensesBefore = await readExpenses(TEST_ACCOUNT_ID);
    const summariesBefore = await readReportSummaries(TEST_ACCOUNT_ID);

    // Inside the "2026 Test" report's range, so a bug that reached the
    // expense lane would move both totals.
    await save({
      merchant: "Home Depot",
      product: "Espresso machine",
      value: "1299.00",
      purchasedAt: "2026-02-01",
    });

    expect(await readExpenses(TEST_ACCOUNT_ID)).toEqual(expensesBefore);
    expect(await readReportSummaries(TEST_ACCOUNT_ID)).toEqual(summariesBefore);
  });
});

describe("createWarrantyFromDocument", () => {
  it("files a dropped image as a warranty read from the document", async () => {
    vi.stubGlobal(
      "fetch",
      completionReply(
        '{"merchant":"Williams Sonoma","product":"Espresso machine",' +
          '"value":"1299","purchased_at":"2026-07-15",' +
          '"expires_at":"2028-07-15","terms":"Two years parts and labor.",' +
          '"confidence":"high","notes":""}',
      ),
    );

    const result = await createWarrantyFromDocument(
      documentForm(await tinyPng(), "receipt.png", "image/png"),
      TEST_ACCOUNT_ID,
    );
    if (result.error !== null) throw new Error(result.error);

    const saved = await readWarranty(result.id, TEST_ACCOUNT_ID);
    expect(saved?.merchant).toBe("Williams Sonoma");
    expect(saved?.product).toBe("Espresso machine");
    expect(saved?.value).toBe("1299.00");
    expect(saved?.purchasedAt).toBe("2026-07-15");
    expect(saved?.expiresAt).toBe("2028-07-15");
    expect(saved?.terms).toBe("Two years parts and labor.");
    // The document it was read from comes with it.
    expect(saved?.documents).toHaveLength(1);
    expect(saved?.documents[0]!.name).toBe("receipt.png");
    expect(
      await readImage(TEST_ACCOUNT_ID, saved!.documents[0]!.key),
    ).not.toBeNull();
  });

  it("files the document anyway when it cannot be read", async () => {
    // A terms PDF: the read runs in text mode, so a dead provider throws
    // straight out of the extraction (no local OCR to fall back to).
    vi.stubGlobal("fetch", async (url: unknown) => {
      if (!String(url).includes("/chat/completions")) {
        // pdf.js fetching standard font data for the text layer.
        return new Response(null, { status: 404 });
      }
      throw new Error("provider unreachable");
    });
    const pdf = await tinyPdf("Warranty terms: 24 months from purchase.");

    const result = await createWarrantyFromDocument(
      documentForm(pdf, "espresso-machine.pdf", "application/pdf"),
      TEST_ACCOUNT_ID,
    );
    if (result.error !== null) throw new Error(result.error);

    const saved = await readWarranty(result.id, TEST_ACCOUNT_ID);
    // Nothing was readable, so the record is named after the file and the
    // document is attached: the file is the point, the fields are a bonus.
    expect(saved?.product).toBe("espresso machine");
    expect(saved?.merchant).toBe("");
    expect(saved?.expiresAt).toBe("");
    expect(saved?.documents).toHaveLength(1);
    // A PDF document stays a PDF (a receipt rasterizes because it is shown
    // as an image; a warranty document is served as itself).
    expect(
      (await readImage(TEST_ACCOUNT_ID, saved!.documents[0]!.key))?.mime,
    ).toBe("application/pdf");
  });

  it("refuses a file that is neither an image nor a PDF, storing nothing", async () => {
    const blobsBefore = await testPrisma.imageBlob.count({
      where: { accountId: TEST_ACCOUNT_ID },
    });
    const result = await createWarrantyFromDocument(
      documentForm(Buffer.from("just some notes"), "notes.txt", "text/plain"),
      TEST_ACCOUNT_ID,
    );
    expect(result).toEqual({ error: "Drop an image or a PDF.", id: null });
    expect(
      await testPrisma.imageBlob.count({
        where: { accountId: TEST_ACCOUNT_ID },
      }),
    ).toBe(blobsBefore);
  });
});
