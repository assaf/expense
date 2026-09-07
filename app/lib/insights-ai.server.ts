import {
  chatCompletion,
  LLMError,
  parseJsonObject,
  type ChatMessage,
} from "~/lib/receipt-ai.server";

/**
 * One-shot conversational filter for the insights chart: the user's
 * free-text question ("my AI expenses", "coffee this year") becomes the
 * app's search-filter syntax (`merchant:z.ai merchant:deepseek ...`),
 * which the chart feeds into the same parseQuery pipeline the home
 * search box uses. No chat history, no tool loop: one cheap LLM call,
 * validated output, editable result.
 */

/** The month windows the chart offers; the model picks one. */
const INSIGHT_MONTH_OPTIONS = [6, 12, 24, 0] as const;

export interface InsightTranslation {
  /** The search-syntax filter string ("" = no filter: everything). */
  query: string;
  /** Short human title for the chart ("AI expenses", "Coffee"). */
  title: string;
  /** 6 / 12 / 24, or 0 for all time. */
  months: number;
}

const MAX_QUERY_LENGTH = 300;

const SYSTEM_PROMPT = `You translate a question about someone's expenses into a filter string for a charting app.

The filter syntax: space-separated tokens of operators and free text.
- merchant:<name> — exact match (case-insensitive) of the merchant name
- category:<name> — exact match of the tax category name
- report:<name> — exact match of the report name
- description:<words> — substring match of the description
- bare words — match merchant, description, category, or amount text
Same operator repeats OR together; different operators AND together.

Rules:
- Pick merchants ONLY from the provided merchant list, copying the exact spelling.
- "X expenses" where X is a topic (AI, coffee, travel, software) usually means
  several merchants ORed together, or a category when one matches exactly.
- Include a category:<name> only when it exactly matches a provided category.
- Include report:<name> only when the user names a specific report.
- If nothing in the list matches the question, return "" (show everything).
- Keep the query under 300 characters.

Answer ONLY a JSON object:
{"query": "<filter string>", "title": "<2-4 word chart title>", "months": 6|12|24|0}
Use months 6, 12, or 24 when the question names a window ("this year" -> 12,
"last two years" -> 24, "recent" -> 6), or 0 for all time / no window mentioned.`;

/** Translate free text into a validated filter. Throws LLMError on
 * transport failure; returns a safe "everything" translation when the
 * model's answer is unusable rather than failing the page. */
export async function translateInsightQuery(input: {
  text: string;
  merchants: string[];
  categories: string[];
  reports: string[];
}): Promise<InsightTranslation> {
  const text = input.text.trim().slice(0, 500);
  const context: string[] = [];
  context.push(
    `Merchants: ${input.merchants.length ? input.merchants.join(", ") : "(none)"}`,
  );
  context.push(
    `Categories: ${input.categories.length ? input.categories.join(", ") : "(none)"}`,
  );
  context.push(
    `Reports: ${input.reports.length ? input.reports.join(", ") : "(none)"}`,
  );
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `${context.join("\n")}\n\nQuestion: ${text}` },
  ];
  const raw = await chatCompletion(messages, {
    json: true,
    maxTokens: 200,
  });
  return parseInsightTranslation(raw);
}

/** Validate a model response into a translation. Unusable output falls
 * back to a bare free-text query ("" = show everything) rather than an
 * error: a garbage answer must not fail the page. Transport failures
 * still throw (the route surfaces them as "try again"). */
export function parseInsightTranslation(raw: string): InsightTranslation {
  let obj: Record<string, unknown>;
  try {
    obj = parseJsonObject(raw);
  } catch {
    return { query: "", title: "Expenses", months: 12 };
  }
  const query = sanitizeQuery(obj.query);
  const months = normalizeMonths(obj.months);
  const title =
    typeof obj.title === "string" && obj.title.trim()
      ? obj.title.trim().slice(0, 60)
      : "Expenses";
  return { query, title, months };
}

function sanitizeQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  // Single line, length-capped; the search parser is token-based so
  // newlines would only confuse it.
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
}

function normalizeMonths(value: unknown): number {
  const n = Number(value);
  return (INSIGHT_MONTH_OPTIONS as readonly number[]).includes(n) ? n : 12;
}

export { LLMError };
