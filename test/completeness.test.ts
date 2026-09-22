import { describe, it, expect } from "vite-plus/test";
import {
  isComplete,
  isReceiptComplete,
  isMileageComplete,
} from "~/lib/completeness";
import type { ReceiptExpense, MileageExpense } from "~/lib/types";

const makeReceipt = (
  overrides: Partial<ReceiptExpense> = {},
): ReceiptExpense => ({
  id: "test1",
  type: "receipt",
  date: "2026-01-15",
  report: "2026 Test",
  category: "Testing",
  description: "",
  amount: "42.50",
  merchant: "Test Store",
  imageFile: "receipt.jpg",
  imageMime: "image/jpeg",
  originalName: "receipt.jpg",
  imageSha256: "",
  currency: "USD",
  originalAmount: "",
  fxRate: "",
  reconciledAt: "",
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

const makeMileage = (
  overrides: Partial<MileageExpense> = {},
): MileageExpense => ({
  id: "test2",
  type: "mileage",
  mileageType: "business",
  date: "2026-03-10",
  report: "2026 Test",
  category: "Travel",
  description: "",
  amount: "22.40",
  locations: [
    { address: "A", lat: 34.05, lng: -118.24 },
    { address: "B", lat: 34.06, lng: -118.25 },
  ],
  distanceMiles: "32.00",
  roundTrip: true,
  route: { coords: [], returnCoords: [] },
  reconciledAt: "",
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

describe("Completeness", () => {
  it("a complete receipt is complete", () => {
    expect(isReceiptComplete(makeReceipt())).toBe(true);
  });

  it("a receipt missing merchant is incomplete", () => {
    expect(isReceiptComplete(makeReceipt({ merchant: "" }))).toBe(false);
  });

  it("a receipt with zero amount is incomplete", () => {
    expect(isReceiptComplete(makeReceipt({ amount: "0.00" }))).toBe(false);
  });

  it("a receipt missing date, category, or report is incomplete", () => {
    expect(isReceiptComplete(makeReceipt({ date: "" }))).toBe(false);
    expect(isReceiptComplete(makeReceipt({ category: "" }))).toBe(false);
    expect(isReceiptComplete(makeReceipt({ report: "" }))).toBe(false);
  });

  it("a receipt with all fields but no image is complete", () => {
    // The image is not a completeness factor; the badge tracks the data
    // fields only.
    expect(isReceiptComplete(makeReceipt({ imageFile: "" }))).toBe(true);
  });

  it("a zero-amount mileage is incomplete", () => {
    expect(isMileageComplete(makeMileage({ amount: "0.00" }))).toBe(false);
  });

  it("a mileage missing date, category, or report is incomplete", () => {
    expect(isMileageComplete(makeMileage({ date: "" }))).toBe(false);
    expect(isMileageComplete(makeMileage({ category: "" }))).toBe(false);
    expect(isMileageComplete(makeMileage({ report: "" }))).toBe(false);
  });

  it("a mileage with fewer than two route addresses is incomplete", () => {
    // The route is what the distance and amount are calculated from.
    expect(isMileageComplete(makeMileage({ locations: [] }))).toBe(false);
    expect(
      isMileageComplete(
        makeMileage({ locations: [makeMileage().locations[0]] }),
      ),
    ).toBe(false);
  });

  it("a complete mileage is complete", () => {
    expect(isMileageComplete(makeMileage())).toBe(true);
  });

  it("isComplete dispatches correctly", () => {
    expect(isComplete(makeReceipt())).toBe(true);
    expect(isComplete(makeMileage())).toBe(true);
    expect(isComplete(makeReceipt({ merchant: "" }))).toBe(false);
  });
});
