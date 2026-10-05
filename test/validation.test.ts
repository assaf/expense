import { describe, expect, it } from "vite-plus/test";
import fc from "fast-check";
import {
  isEmail,
  extractEmailAddress,
  sanitizeFilenamePart,
  formString,
  unknownIntent,
  validateDate,
  validateDateNotFuture,
  badRequest,
  notFound,
  domainOf,
  formEmail,
  isCalendarDate,
  normalizeRuleSender,
} from "~/lib/validation";
import { assertProperty, text } from "./helpers/property";

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
    // Leading/trailing spaces are trimmed by isEmail, so they don't
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
    // group (no @ inside), so no match, falls back to the raw string.
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

describe("badRequest", () => {
  it("returns the error message in a 400 JSON envelope", async () => {
    const res = badRequest("nope");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({ error: "nope" });
  });
});

describe("notFound", () => {
  it("returns a 404 JSON envelope", async () => {
    const res = notFound();
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
  });
});

describe("validateDate", () => {
  it("returns null for a valid past date", () => {
    expect(validateDate("2026-01-15")).toBeNull();
  });

  it("allows future dates (an invoice can predate its payment)", () => {
    expect(validateDate("2099-12-31")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(validateDate("")).toBeNull();
  });

  it("returns an error for non-date strings", () => {
    expect(validateDate("next Tuesday")).toContain("valid");
  });

  it("returns an error for partial dates", () => {
    expect(validateDate("2026-01")).toContain("valid");
  });

  it("returns an error for dates that do not exist", () => {
    // Date.UTC rolls these forward silently (Feb 31 becomes Mar 3), so the
    // shape check alone would let them into the ledger.
    expect(validateDate("2026-02-31")).toContain("valid");
    expect(validateDate("2026-04-31")).toContain("valid");
    expect(validateDate("2026-13-01")).toContain("valid");
    expect(validateDate("2026-00-10")).toContain("valid");
  });

  it("accepts the last real day of a month, including a leap day", () => {
    expect(validateDate("2026-02-28")).toBeNull();
    expect(validateDate("2024-02-29")).toBeNull();
    expect(validateDate("2023-02-28")).toBeNull();
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

  it("clamps a client ceiling to a day past the server's date", () => {
    // The reconcile flow sends the browser's local date; a browser in
    // UTC+14 is legitimately a day ahead, anything further is forged.
    expect(validateDateNotFuture("2026-07-16", "2026-07-16")).toBeNull();
    expect(validateDateNotFuture("2026-08-01", "2099-12-31")).toContain(
      "future",
    );
  });
});

describe("thrown error envelopes carry statusText for error boundaries", () => {
  it("notFound sets statusText + keeps the JSON envelope", () => {
    const res = notFound();
    expect(res.status).toBe(404);
    expect(res.statusText).toBe("Not found");
  });

  it("badRequest mirrors the message into statusText", () => {
    const res = badRequest("Bad intent");
    expect(res.status).toBe(400);
    expect(res.statusText).toBe("Bad intent");
  });

  it("unknownIntent sets statusText", () => {
    expect(unknownIntent().statusText).toBe("Unknown intent.");
  });
});

const ADDRESS_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789._-".split("");

/** Address characters only: the module's inner regex forbids `<`, `>`, `@`
 * and whitespace inside an address, so those cannot appear in one. Both
 * halves need at least one character: the regex requires it, so an empty
 * local or domain leaves nothing to extract. */
const addressChars = (maxLength: number): fc.Arbitrary<string> =>
  fc.string({
    unit: fc.constantFrom(...ADDRESS_CHARS),
    minLength: 1,
    maxLength,
  });

describe("app/lib/validation.ts properties", () => {
  it("sanitizeFilenamePart is idempotent and yields a safe token", () => {
    // Each clause follows from the transform's own steps: strip
    // `\/:*?"<>|`, collapse whitespace to `_`, collapse `_` runs, trim edge
    // `_`. A second pass has nothing left to do on any of the four.
    assertProperty([text(64)], (s) => {
      const once = sanitizeFilenamePart(s);
      expect(sanitizeFilenamePart(once)).toBe(once);
      expect(once).toMatch(/^[^\s\\/:*?"<>|]*$/);
      expect(once).not.toContain("__");
      expect(once.startsWith("_")).toBe(false);
      expect(once.endsWith("_")).toBe(false);
    });
  });

  it("extractEmailAddress is idempotent and lowercased", () => {
    assertProperty([text(64)], (s) => {
      const once = extractEmailAddress(s);
      expect(extractEmailAddress(once)).toBe(once);
      expect(once).toBe(once.toLowerCase());
    });
  });

  it("extractEmailAddress pulls the address out of angle brackets", () => {
    // The display name is arbitrary text; the address carries none of the
    // characters the inner regex forbids, so the bracketed pair is the only
    // match in the string.
    assertProperty(
      [text(20), addressChars(12), addressChars(12)],
      (name, local, domain) => {
        const input = `${name} <${local}@${domain}>`;
        expect(extractEmailAddress(input)).toBe(
          `${local}@${domain}`.toLowerCase(),
        );
      },
    );
  });

  it("isCalendarDate accepts a real date and refuses a rolled one", () => {
    assertProperty(
      [fc.integer({ min: 0, max: 15 }), fc.integer({ min: 0, max: 35 })],
      (m, d) => {
        if (m < 1 || m > 12 || d < 1 || d > 31) {
          // The guard the module documents for Date.UTC's silent
          // roll-forward.
          expect(isCalendarDate(2026, m, d)).toBe(false);
          return;
        }
        // Day 28 exists in every month, so the in-range half only has to
        // prove the range check passed it.
        expect(isCalendarDate(2026, m, 28)).toBe(true);
      },
    );
  });

  it("validateDate never invents a date", () => {
    assertProperty([text(10)], (s) => {
      const error = validateDate(s);
      if (error !== null) return;
      if (s === "") return;
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      expect(m).not.toBeNull();
      expect(isCalendarDate(Number(m![1]), Number(m![2]), Number(m![3]))).toBe(
        true,
      );
    });
  });

  it("domainOf returns null without a dotted domain part", () => {
    assertProperty([text(40)], (s) => {
      const domain = domainOf(s);
      if (domain === null) return;
      const part = s.split("@")[1];
      expect(part).toBeDefined();
      expect(part).toContain(".");
    });
  });

  it("domainOf returns the lowercased domain of an address", () => {
    assertProperty([addressChars(12), addressChars(12)], (local, domain) => {
      if (!domain.includes(".")) return;
      const expected = domain.toLowerCase();
      expect(domainOf(`${local}@${domain}`)).toBe(expected);
      expect(domainOf(`${local}@${domain.toUpperCase()}`)).toBe(expected);
    });
  });

  it("formEmail normalizes the identity field", () => {
    assertProperty([text(64)], (value) => {
      const form = new FormData();
      form.set("email", value);
      // Normalized at the form boundary: emails are stored and compared
      // lowercased server-side, so every auth route has to agree.
      const email = formEmail(form);
      expect(email).toBe(value.trim().toLowerCase());
      form.set("email", email);
      expect(formEmail(form)).toBe(email);
    });
  });

  it("normalizeRuleSender hands back a fixed point of its own normalization", () => {
    // Whatever it accepts (a full address, or a bare dotted domain), it
    // returns the trimmed lowercased form, so feeding the result back is a
    // no-op. Asserting that rather than re-deriving its two accepted shapes:
    // a property that reimplements the branch proves only that the copy was
    // made correctly, not that the branch is right.
    assertProperty([text(64)], (sender) => {
      const result = normalizeRuleSender(sender);
      if (result === null) return;
      expect(result).toBe(sender.trim().toLowerCase());
      expect(normalizeRuleSender(result)).toBe(result);
    });
  });
});
