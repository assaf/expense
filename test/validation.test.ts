import { describe, expect, it } from "vitest";
import {
  isEmail,
  extractEmailAddress,
  sanitizeFilenamePart,
  formString,
  unknownIntent,
  validateDateNotFuture,
} from "~/lib/validation";

describe("isEmail", () => {
  it("accepts valid email addresses", () => {
    expect(isEmail("user@example.com")).toBe(true);
    expect(isEmail("user.name+tag@example.co.uk")).toBe(true);
    expect(isEmail("a@b.io")).toBe(true);
  });

  it("rejects empty and blank input", () => {
    expect(isEmail("")).toBe(false);
    expect(isEmail("   ")).toBe(false);
  });

  it("rejects strings without @", () => {
    expect(isEmail("not-an-email")).toBe(false);
    expect(isEmail("user at domain.com")).toBe(false);
  });

  it("rejects strings with internal spaces", () => {
    expect(isEmail("user @example.com")).toBe(false);
    // Leading/trailing spaces are trimmed by isEmail — they don't
    // make an email invalid. Only spaces within the address itself
    // cause rejection.
    expect(isEmail(" user@example.com")).toBe(true);
  });

  it("rejects missing domain part", () => {
    expect(isEmail("user@")).toBe(false);
    expect(isEmail("@example.com")).toBe(false);
  });

  it("rejects addresses longer than 254 characters", () => {
    // 249-char local + @ + 4-char domain = 254 total → accepted.
    const exactly254 = "a".repeat(249) + "@b.co";
    expect(exactly254.length).toBe(254);
    expect(isEmail(exactly254)).toBe(true);
    // One character over → rejected.
    expect(isEmail("a".repeat(251) + "@b.co")).toBe(false);
  });
});

describe("extractEmailAddress", () => {
  it("strips a display name and lowercases the address", () => {
    expect(extractEmailAddress("Forwarder <Foo@Bar.com>")).toBe("foo@bar.com");
  });

  it("passes through a bare address", () => {
    expect(extractEmailAddress("plain@address.com")).toBe("plain@address.com");
  });

  it("returns empty for empty input", () => {
    expect(extractEmailAddress("")).toBe("");
  });

  it("extracts from angle brackets anywhere in the string", () => {
    expect(extractEmailAddress("<nested@example.com>")).toBe(
      "nested@example.com",
    );
  });

  it("trims whitespace around the address", () => {
    expect(extractEmailAddress("  user@example.com  ")).toBe(
      "user@example.com",
    );
  });

  it("falls back to raw string when angle brackets contain no @", () => {
    // Not a real email address, but the regex matches the angle-bracket
    // group — no @ inside, so no match, falls back to the raw string.
    expect(extractEmailAddress("<not-an-email>")).toBe("<not-an-email>");
  });
});

describe("sanitizeFilenamePart", () => {
  it("replaces spaces and underscores with a single underscore", () => {
    expect(sanitizeFilenamePart("My Report Name")).toBe("My_Report_Name");
    expect(sanitizeFilenamePart("a  b__c")).toBe("a_b_c");
  });

  it("strips forbidden characters", () => {
    expect(sanitizeFilenamePart("test:file?name")).toBe("testfilename");
    expect(sanitizeFilenamePart('abc\\def/g*h:i"j<k>l|m')).toBe(
      "abcdefghijklm",
    );
  });

  it("trims leading and trailing underscores", () => {
    expect(sanitizeFilenamePart("  hello  ")).toBe("hello");
    expect(sanitizeFilenamePart("___trimmed___")).toBe("trimmed");
  });

  it("handles empty input", () => {
    expect(sanitizeFilenamePart("")).toBe("");
    expect(sanitizeFilenamePart("   ")).toBe("");
  });

  it("handles a mix of special chars and spaces", () => {
    expect(sanitizeFilenamePart("Q1: Report (draft)")).toBe(
      "Q1_Report_(draft)",
    );
  });
});

describe("formString", () => {
  it("returns the string value of a form field", () => {
    const form = new FormData();
    form.set("name", "Alice");
    expect(formString(form, "name")).toBe("Alice");
  });

  it("returns empty string for missing fields", () => {
    const form = new FormData();
    expect(formString(form, "nope")).toBe("");
  });

  it("returns empty string when the field is a File", () => {
    const form = new FormData();
    form.set("file", new File([""], "test.txt"));
    expect(formString(form, "file")).toBe("");
  });
});

describe("unknownIntent", () => {
  it("returns a 400 JSON response", async () => {
    const res = unknownIntent();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Unknown intent");
  });
});

describe("validateDateNotFuture", () => {
  it("returns null for a valid past date", () => {
    expect(validateDateNotFuture("2026-01-15")).toBeNull();
  });

  it("returns an error for a future date", () => {
    const future = "2099-12-31";
    expect(validateDateNotFuture(future)).toContain("future");
  });

  it("returns null for empty input", () => {
    expect(validateDateNotFuture("")).toBeNull();
  });

  it("returns an error for non-date strings", () => {
    expect(validateDateNotFuture("next Tuesday")).toContain("valid");
  });

  it("returns an error for partial dates", () => {
    expect(validateDateNotFuture("2026-01")).toContain("valid");
  });
});
