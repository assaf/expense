import { describe, expect, it } from "vitest";

/**
 * expense-read-tools.ts: the contract shared by the MCP server and the
 * WebMCP in-page tools. The three surfaces it synchronizes (URL parsing,
 * JSON tool schemas, query-string building) must agree with each other and
 * with the MCP zod derivation, or the two agent surfaces drift apart.
 */

import {
  EXPENSE_FILTER_FIELDS,
  READ_TOOLS,
  expenseFilterJsonSchema,
  filtersToQuery,
  parseExpenseFilters,
} from "~/lib/expense-read-tools";

describe("parseExpenseFilters", () => {
  it("parses the shared fields and ignores everything else", () => {
    const params = new URLSearchParams(
      "dateFrom=2026-01-01&type=mileage&merchant=blue&junk=1",
    );
    expect(parseExpenseFilters(params)).toEqual({
      dateFrom: "2026-01-01",
      type: "mileage",
      merchant: "blue",
    });
  });

  it("accepts only enum values and bare true booleans", () => {
    const params = new URLSearchParams("type=receipt&unreported=true");
    expect(parseExpenseFilters(params)).toEqual({
      type: "receipt",
      unreported: true,
    });
    expect(parseExpenseFilters(new URLSearchParams("type=vehicle"))).toEqual(
      {},
    );
    expect(parseExpenseFilters(new URLSearchParams("unreported=1"))).toEqual(
      {},
    );
    expect(parseExpenseFilters(new URLSearchParams("category="))).toEqual({});
  });
});

describe("filtersToQuery", () => {
  it("keeps declared scalar keys, including limit from the tool schema", () => {
    const schema = expenseFilterJsonSchema({ withLimit: true });
    expect(filtersToQuery({ limit: 5, category: "Meals" }, schema)).toBe(
      "limit=5&category=Meals",
    );
  });

  it("drops undeclared and empty values", () => {
    const schema = expenseFilterJsonSchema();
    expect(
      filtersToQuery({ category: "Meals", hack: "1", merchant: "" }, schema),
    ).toBe("category=Meals");
  });

  it("without a schema, allows exactly the shared filter fields", () => {
    expect(filtersToQuery({ unreported: true, limit: 3 })).toBe(
      "unreported=true",
    );
  });
});

describe("expenseFilterJsonSchema", () => {
  it("describes every shared filter field", () => {
    const schema = expenseFilterJsonSchema() as {
      type: string;
      properties: Record<string, { type: string; description?: string }>;
    };
    for (const field of EXPENSE_FILTER_FIELDS) {
      expect(schema.properties[field.name]).toBeDefined();
    }
    expect(schema.properties.type).toEqual({
      type: "string",
      enum: ["receipt", "mileage"],
    });
    expect(schema.properties.limit).toBeUndefined();
  });

  it("adds the limit property only when asked", () => {
    const withLimit = expenseFilterJsonSchema({ withLimit: true }) as {
      properties: Record<string, { type: string; description: string }>;
    };
    expect(withLimit.properties.limit).toMatchObject({ type: "number" });
  });
});

describe("READ_TOOLS catalog", () => {
  it("lists exactly the three read tools, with schemaless list_reports last", () => {
    expect(READ_TOOLS.map((t) => t.name)).toEqual([
      "list_expenses",
      "expense_summary",
      "list_reports",
    ]);
    const [list, summary, reports] = READ_TOOLS;
    expect(list.resource).toBe("expenses");
    expect(summary.resource).toBe("summary");
    expect(reports.resource).toBe("reports");
    expect(list.inputSchema).toBeDefined();
    expect(summary.inputSchema).toBeDefined();
    expect(reports.inputSchema).toBeUndefined();
    for (const tool of READ_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });
});
