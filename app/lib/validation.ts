import { z } from "zod";

/** Sanitize a free-text name into a filesystem-safe token (spaces → _). */
export function sanitizeFilenamePart(input: string): string {
  return input
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export const locationSchema = z.object({
  address: z.string(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
});

/** Form payload posted by the expense editor. */
export const expenseSaveSchema = z.object({
  id: z.string(),
  type: z.enum(["receipt", "mileage"]),
  date: z.string(),
  report: z.string(),
  category: z.string(),
  description: z.string(),
  amount: z.string(),
  // receipt-only
  merchant: z.string().optional(),
  imageFile: z.string().optional(),
  imageMime: z.string().optional(),
  originalName: z.string().optional(),
  // mileage-only
  locations: z.array(locationSchema).optional(),
  distanceMiles: z.string().optional(),
});

export type ExpenseSaveInput = z.infer<typeof expenseSaveSchema>;

export const newExpenseSchema = z.object({
  type: z.enum(["receipt", "mileage"]),
});

export const settingsSchema = z.object({
  homeAddress: z.string(),
  homeLat: z.number().nullable(),
  homeLng: z.number().nullable(),
  mileageRates: z.record(z.string(), z.string()),
});

export type SettingsInput = z.infer<typeof settingsSchema>;

/** Read a FormData field as a string (files become ""). */
export function formString(form: FormData, key: string): string {
  const v = form.get(key);
  return v instanceof File ? "" : (v ?? "");
}

/** Coerce a FormDataEntryValue to a string (files become ""). */
export function entryString(v: FormDataEntryValue): string {
  return v instanceof File ? "" : v;
}

/** Validate that a date string is YYYY-MM-DD and not in the future. */
export function validateDateNotFuture(date: string): string | null {
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Use a valid calendar date.";
  const today = new Date();
  const tzOffset = today.getTimezoneOffset() * 60_000;
  const todayStr = new Date(today.getTime() - tzOffset)
    .toISOString()
    .slice(0, 10);
  if (date > todayStr) return "Date cannot be in the future.";
  return null;
}
