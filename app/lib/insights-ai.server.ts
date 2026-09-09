import {
  chatCompletion,
  LLMError,
  parseJsonObject,
  type ChatMessage,
} from "~/lib/receipt-ai.server";
import { categorySynonyms } from "~/lib/expense-search";

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
  /** false = the question is best answered in words (a comparison,
   * total, or count); true = show the chart. */
  chart: boolean;
}

const MAX_QUERY_LENGTH = 300;

const SYSTEM_PROMPT = `You translate a question about someone's expenses into a filter string for a charting app.

The filter syntax: space-separated tokens of operators and free text.
- merchant:<name> — exact match (case-insensitive) of the merchant name
- category:<name> — exact match of the tax category name
- report:<name> — exact match of the report name
- Aliases work and parse identically: from:/vendor:/store:/seller: =
  merchant:, cat: = category:, in:/for: = report:, desc:/note:/notes: =
  description:. Prefer the canonical form in your answer.

Same operator repeats OR together; different operators AND together.

Rules:
- Merchant selection decides what the chart shows — precision beats
  recall. Work from what each expense WAS, not what else the company
  sells or powers. "My AI expenses" means the AI services themselves
  (OpenAI, Anthropic, DeepSeek, z.ai) — NOT the hosting, DNS, CDN,
  email, or app-store subscriptions that support anything you run:
  Vercel, Cloudflare, Hetzner, BunnyCDN, Fastmail, Setapp, 1Password
  are never AI expenses, even though they are technology. The same
  logic applies to every topic: a bookstore is not "books I read about
  cooking", a gas station is not "my road trip".
- Pick merchants ONLY from the provided merchant list, copying the exact
  spelling INCLUDING any parenthesized category annotation. The
  annotation is supporting evidence, not permission: a match on the
  category alone (same subscription category) does not qualify.
- "X expenses" where X is a topic means the merchants whose product IS
  that thing. When a merchant is doubtful, leave it OUT: a missing
  merchant is an editable omission, a wrong one hides unrelated
  spending.
- Include a category:<name> only when it exactly matches a provided category.
- A category may list built-in synonyms after "also means" — a question
  using one of those words ("gas", "food", "software") means that category.
- Money questions ("between $100 and $110", "over $50", "under $20") map to
  amount ranges: amount:100-110, amount:50+, amount:-20.
- Include report:<name> only when the user names a specific report.
- If nothing in the list matches the question, return "" (show everything).
- Keep the query under 300 characters.

Answer ONLY a JSON object:
{"query": "<filter string>", "title": "<2-4 word chart title>", "months": 6|12|24|0, "chart": true|false}
Set chart=false ONLY when the answer is a single sentence a monthly
chart cannot show: yes/no or "did I spend more A than B" comparisons,
counts of matching expenses, or questions about non-time data (lists of
categories, merchants, reports). EVERYTHING else is chart=true — any
"what's my X spend <window>?", "how much did I spend on gas?", trends,
or spending-over-time questions: the monthly chart and expense table
are part of the answer, alongside the text summary.
Chart decision examples:
- "what's my medical spend this year?" -> chart:true
- "how much did I spend on gas?" -> chart:true
- "show my coffee trend over time" -> chart:true
- "did I spend more on AI this month than last?" -> chart:false
- "how many expenses over $100?" -> chart:false
- "what categories do I have?" -> chart:false.
Use months 6, 12, or 24 when the question names a window ("this year" -> 12,
"last two years" -> 24, "recent" -> 6), or 0 for all time / no window mentioned.

Previous exchanges may be provided: resolve short follow-ups ("and last
month?", "what about coffee?") against them.`;

/** Translate free text into a validated filter. Throws LLMError on
 * transport failure; returns a safe "everything" translation when the
 * model's answer is unusable rather than failing the page. */
export async function translateInsightQuery(input: {
  text: string;
  history?: { question: string; answer: string }[];
  /** The client's local date (YYYY-MM-DD), so "this month" resolves. */
  today?: string;
  merchants: string[];
  categories: string[];
  reports: string[];
}): Promise<InsightTranslation> {
  const text = input.text.trim().slice(0, 500);
  const context: string[] = [];
  if (input.today && /^\d{4}-\d{2}-\d{2}$/.test(input.today)) {
    context.push(`Current date: ${input.today}`);
  }
  context.push(
    `Merchants: ${input.merchants.length ? input.merchants.join(", ") : "(none)"}`,
  );
  context.push(
    `Categories: ${
      input.categories.length
        ? input.categories
            .map((c) => {
              const syn = categorySynonyms(c);
              return syn.length ? `${c} (also means: ${syn.join(", ")})` : c;
            })
            .join(", ")
        : "(none)"
    }`,
  );
  context.push(
    `Reports: ${input.reports.length ? input.reports.join(", ") : "(none)"}`,
  );
  for (const h of input.history ?? []) {
    context.push(`Previous exchange:\nQ: ${h.question}\nA: ${h.answer}`);
  }
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
    return { query: "", title: "Expenses", months: 12, chart: true };
  }
  const query = sanitizeQuery(obj.query);
  const months = normalizeMonths(obj.months);
  const title =
    typeof obj.title === "string" && obj.title.trim()
      ? obj.title.trim().slice(0, 60)
      : "Expenses";
  // Absent field -> true: showing the chart stays the default.
  const chart = typeof obj.chart === "boolean" ? obj.chart : true;
  return { query, title, months, chart };
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

const ANSWER_PROMPT = `You are Expense, an expense tracker developed by
Assaf Arkin. You answer questions about someone's expenses using ONLY the
computed data provided with the question.
An "About the user" section may describe them (name, home location, email
addresses, categories, reports) — use it when the question touches it
("what's my name?", "where do I live?", "what categories do I have?").
Report entries may include "(created <date, time>)" — dates are already
formatted in the user's local timezone and preferred style. When asked
for reports, list every report from that section and copy each date
EXACTLY as written; for entries without one, say the report predates
date tracking.
- Lead with the direct answer, then any supporting detail.
- Use the exact dollar figures and counts from the data; never invent or
  estimate numbers.
- If the data does not answer the question, say so plainly.
- Short answers are plain prose. When the answer has detail worth
  structuring, use markdown: **bold** for key figures and a table for
  breakdowns (see below).
- EVERY multi-item breakdown in the data ("By month:", "Top merchants:",
  "By category:") must be rendered as a markdown table — one row per
  item, never a bullet list or an inline semicolon list.
- Tables use EXACTLY this shape (pipes, a '---' separator row under the
  header, one row per line):
  | Month | Total | Expenses |
  |---|---|---|
  | Jun | $95.00 | 3 |
  | Jul | $105.00 | 2 |
  or for merchants:
  | Merchant | Amount |
  |---|---|
  | Z.ai | $80.00 |
  Never improvise another structure (no indented columns, no bullet
  tables). No links, no headings.`;

/** Produce the text answer for a question, grounded in data the app
 * computed from the user's real expenses (the model only phrases it).
 * Throws LLMError on transport failure. */
export async function answerInsightQuestion(input: {
  question: string;
  history: { question: string; answer: string }[];
  summary: string;
  profile?: string;
}): Promise<string> {
  const parts: string[] = [];
  if (input.profile) {
    parts.push(`About the user:\n${input.profile}`);
  }
  if (input.history.length > 0) {
    parts.push(
      `Previous exchanges:\n${input.history
        .map((h) => `Q: ${h.question}\nA: ${h.answer}`)
        .join("\n")}`,
    );
  }
  parts.push(`Computed data:\n${input.summary}`);
  parts.push(`Question: ${input.question}`);
  const raw = await chatCompletion(
    [
      { role: "system", content: ANSWER_PROMPT },
      { role: "user", content: parts.join("\n\n") },
    ],
    { maxTokens: 200 },
  );
  const text = raw.trim().replace(/^["']|["']$/g, "");
  return text || "I couldn't summarize that.";
}

export { LLMError };
