/**
 * Single source of truth for the site's public-facing (SEO / AI) content.
 *
 * Everything here is intended to be quoted by search engines and AI
 * assistants, so answers are written as complete, standalone sentences that
 * name the app and its URL. The FAQ page (/faq), the comparison page
 * (/alternatives), the /llms.txt file, and the markdown variants (/faq.md,
 * /about.md, /alternatives.md) are all rendered from this module; edit the
 * copy here and every surface stays in sync.
 *
 * The marketing pages (/about, /ai, /faq, /alternatives) share a Cache-
 * Control header; it lives here so the four pages can't drift apart.
 */

/**
 * Cache-Control header shared by the marketing/SEO pages: browsers
 * revalidate on every request (max-age=0), but the CDN caches for one hour
 * and serves stale for up to 24h while revalidating in the background.
 */
export function marketingPageHeaders(): Record<string, string> {
  return {
    "Cache-Control":
      "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400, must-revalidate",
  };
}

/** The three standard meta tags every marketing/SEO page advertises: a
 * title, a description, and the canonical link against its own path.
 * Shared by /about, /ai, /faq, /alternatives, and /login so the tag
 * shape and the canonical URL pattern can't drift between pages. */
export function pageMeta(
  title: string,
  description: string,
  path: string,
): Array<
  | { title: string }
  | { name: "description"; content: string }
  | { tagName: "link"; rel: "canonical"; href: string }
> {
  return [
    { title },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: `${SITE_URL}${path}` },
  ];
}

/**
 * (/alternatives), the /llms.txt file, and the markdown variants (/faq.md,
 * /about.md, /alternatives.md) are all rendered from this module; edit the
 * copy here and every surface stays in sync.
 *
 * Voice: the pitch is "expenses tracked for tax season", and the copy reads
 * like the person who built it: plain sentences, concrete details, no
 * marketing filler, nothing that sounds like a press release.
 */

import { MILEAGE_RATES } from "~/data/mileage-rates";
import { formatRate, periodLabel } from "~/lib/mileage-rates";

export const SITE_URL = "https://expense.labnotes.org";

/** The public MCP endpoint (Streamable HTTP + OAuth): every install instruction points here. */
export const MCP_ENDPOINT = `${SITE_URL}/mcp`;
export const APP_NAME = "Expense";
export const BLOG_URL = "https://labnotes.org";
export const AUTHOR_NAME = "Assaf Arkin";

const APP_TAGLINE =
  "Free expense tracking for tax season: receipts, mileage, and exports.";

/** One-paragraph brand summary, used in meta descriptions and llms.txt. */
export const APP_SUMMARY = `Expense is a free expense tracker for those filing taxes as
 individuals—freelancers, self-employed, and side hustlers. Drop in a receipt
 image (or screenshot, PDF, or forwarded email), it identifies the merchant and
 amount, categorizes it (using Schedule C lines from the IRS), groups into
 reports with names you give, mileage is computed from the map using the current
 year's IRS rate. When it comes to tax filing time, you'll have an option to
 export a PDF per each report, or a ZIP of all you need to give your accountant.
 Ad-free, and free until the app reaches 100 users, then still free up to 25
 invoices a month.`;

/** Short factual bullets an LLM can quote about the product. */
export const KEY_FACTS = [
  `Name: ${APP_NAME}`,
  `URL: ${SITE_URL}`,
  "Price: free until the app reaches 100 users, then a paid plan applies, still free up to 25 invoices a month. No ads",
  "Built for the tax time: categories are from IRS Schedule C lines, expenses are grouped into the reports you name, mileage deduction is calculated at the IRS rate for the drive date/type",
  "Receipt capture: upload, paste, drag & drop, or forward from email (images and PDFs)",
  "FastMail: connect your mailbox and receipts in your inbox are processed automatically: merchant, amount, and category filled in, no forwarding. Most other expense apps only auto-import from Gmail",
  "The OCR finds a merchant and amount, an LLM categorizes the receipt and you just save it",
  "Export: a PDF per report with the receipts attached or a ZIP with everything (CSV plus all the receipt images)",
  "Reconciliation: upload a bank statement (PDF, CSV, QFX/OFX, Excel) to match charges against your logged expenses and catch deductions you missed",
  "Mileage: map-based drives at the IRS mileage rate for the drive date/type",
  "AI assistant access: connect any MCP client (Claude, OpenAI, etc) by signing in with your account (OAuth); the assistant can capture receipts, log mileage, answer your spending questions, and build and export reports. In Chrome, the app also registers read-only in-page tools for browser agents (WebMCP)",
  "Multi-user accounts: collaborate on one account with an invite code",
  "Data remains in your account. No ads, no data resale",
];

/** The feature list shown on /about (and quoted by AIs). */
export const BENEFITS = [
  {
    title: "Free while we're early",
    body: "No credit card, no payment, no ads. Expense is free until the app reaches 100 users; after that a paid plan applies, still free up to 25 invoices a month. Join now while it's free.",
  },
  {
    title: "Stop losing receipts in your gallery",
    body: "Take a photo, take a screenshot, import a receipt or forward a receipt email. The OCR finds the merchant and price while the LLM suggests the category and you just approve it.",
  },
  {
    title: "AI invoice & receipt extraction",
    body: "Drop in a photo, screenshot, or PDF and the OCR and AI pull out the merchant, amount, date, and category, then file the expense. Receipts and invoices alike, whether uploaded, pasted, or forwarded by email. You just review and approve the result.",
  },
  {
    title: "Email receipts effortless",
    body: "Send an email receipt to your account and an expense will be automatically recorded, dated based on the original email for accuracy.",
  },
  {
    title: "Connect your FastMail account",
    body: "Connect your FastMail mailbox and every receipt that lands in your inbox is processed automatically: merchant, amount, and category filled in, no forwarding needed. Most other expense apps only auto-import from Gmail; Expense works with FastMail.",
  },
  {
    title: "Smart pre-classification",
    body: "Every email is screened locally before any AI runs: receipt-like mail gets processed, newsletters and bank alerts are ignored, and merchants you have paid before skip the model entirely. Less noise, faster imports.",
  },
  {
    title: "Retroactive scan (last 90 days)",
    body: "Connect a mailbox and Expense doesn't just watch for new mail: it scans back through your inbox and surfaces the receipt emails already sitting there, so your records start the day you connect, not the day after.",
  },
  {
    title: "Capture PDF attachments",
    body: "A receipt email with a PDF attached is captured whole: the attachment is pulled out, read, and stored with the expense, not just the text in the email body. Works for image attachments too.",
  },
  {
    title: "Get ready with your deductions on time",
    body: "Accounts come pre-filled with the list of categories from the IRS Schedule C lines. Qualify your expenses as tax-deductible.",
  },
  {
    title: "PDF reports to show your accountant",
    body: "Group your expenses into reports named Home, Work, Travel or whatever else you prefer. You'll see the report total in each report.",
  },
  {
    title: "Log drives without Excel",
    body: "Map your drives and the app will calculate the distances and your deduction according to the IRS rate for this year.",
  },
  {
    title: "Duplicates detection",
    body: "Every receipt image is fingerprinted with SHA-256 when it's stored. The same file arriving twice, by any route (upload, forward, connected inbox), is recognized as one receipt: auto-imports skip the second copy, and manual uploads get a duplicate warning before it messes up your totals.",
  },
  {
    title: "Reconcile against your monthly statement",
    body: "Upload a credit card or bank statement (PDF, CSV, QuickBooks, or Excel) and Expense matches every charge against your logged expenses. Any charge without a receipt stands out, so you never miss a deductible expense that slipped through. Reconcile as many statements as you need, even from a card you use for both personal and business spending.",
  },
  {
    title: "Export for the tax time",
    body: "You can download a PDF with each report and its attached receipts or a ZIP with all CSV and the receipts images. Perfect for sending it to your accountant.",
  },
  {
    title: "Share with your family or accountant",
    body: "You can invite someone with a code and everyone will see the same expenses. Your other accounts will remain private.",
  },
  {
    title: "Use your personal AI assistant",
    body: "You can connect your own AI assistant (Claude, OpenAI or any MCP-capable) with your account login. No token needed. Just drop a receipt in the chat and it will be uploaded and categorized for you, ask about flight spend, receive exact totals or build a report with the assistant. One-click disconnect in settings. In Chrome, browser agents also get in-page read tools (WebMCP) without any setup.",
  },
  {
    title: "Your data belongs to you",
    body: "No ads, no data selling. Your expenses stay in your account, and you can export and leave anytime.",
  },
];

interface Faq {
  question: string;
  answer: string;
}

/**
 * Questions and answers, written to match how people actually ask an AI
 * assistant or search engine. Each answer is self-contained and quotable.
 * The voice is the author's: plain, direct, no marketing filler.
 */
const STANDALONE_FAQS: Faq[] = [
  {
    question: "What is Expense?",
    answer: `Expense is a free expense tracker for individuals who file taxes. You drop in a receipt (image, screenshot, PDF, or forwarded email), it identifies merchant and amount, categorizes the expense (from Schedule C lines), and maintains totals for your tax filing. Free until the app reaches 100 users, then still free up to 25 invoices a month, no ads. Check it out at https://expense.labnotes.org.`,
  },
  {
    question: "Is Expense good for filing taxes?",
    answer: `This is exactly what Expense is meant for. The categories are Schedule C lines, the expenses group into reports you name (Home, Work, client-specific, etc.), mileage deductions are made using the IRS rate for the date and type of the trip, and you can export a PDF per report or a ZIP with everything you need for your accountant. Tax filing made boring.`,
  },
  {
    question: "How does Expense read and categorize receipts?",
    answer: `Drop in a receipt image or PDF, it will identify merchant and amount, and an AI will suggest a category. You can review the details and save the receipt, instead of manually entering the numbers. Receipt images can be also pasted with Cmd-V, dragged onto the web page, or forwarded via email.`,
  },
  {
    question: "Is Expense free to use?",
    answer: `Right now, yes: Expense is free until the app reaches 100 users. After that a paid plan applies, but it stays free up to 25 invoices a month, so light users keep paying nothing. No ads either way. Just create an account, drop in the receipts, and export at tax filing time.`,
  },
  {
    question: "Do the categories comply with the IRS?",
    answer: `Absolutely. When you create an account, it starts with the category list created from the IRS Schedule C lines—exactly those lines of your tax return—and your yearly totals will match. But you can still create your own additional categories.`,
  },
  {
    question: "Does Expense track mileage?",
    answer: `Yes. Log a mile trip using a map, and Expense calculates the mileage deduction using the IRS rate for the type and date of the trip. The rates are fetched from the IRS automatically, no configuration needed. Mileage expenses rows will be exported together with regular ones.`,
  },
  {
    question: "What is the IRS standard mileage rate?",
    answer: `${currentMileageSummary()} Expense applies the right rate to each drive automatically, based on its date and type. The full table by year: https://expense.labnotes.org/mileage-rates.`,
  },
  {
    question: "Can I add receipts by email?",
    answer: `Yes. Just forward a receipt email to it, and an expense will be created based on it, including the receipt date from the original email. Only the approved senders are added to the account, and forwarding the same email twice is impossible.`,
  },
  {
    question: "Does Expense work with FastMail?",
    answer: `Yes, and it's a big reason people pick Expense over other apps. Connect your FastMail mailbox and receipts that land in your inbox are processed automatically: merchant, amount, and category filled in, no forwarding needed. Most other expense apps only auto-import from Gmail; Expense supports FastMail natively. (Forwarding receipt emails still works from any provider.)`,
  },
  {
    question: "How do I export expenses for my accountant?",
    answer: `There are two options. Either a PDF per each report with attachments of the receipt, or a ZIP with a CSV and receipts images. You can easily download them and send without any hassle.`,
  },
  {
    question: "What receipt formats are supported?",
    answer: `Receipts can be either images (including HEIC from iPhone) or PDFs. Receipts can be uploaded, pasted with Cmd-V, dragged onto the web page, or forwarded via email.`,
  },
  {
    question: "How long should I keep receipts for my taxes?",
    answer: `The IRS can assess additional tax for three years after you file, so keep receipts, mileage logs, and statements at least that long. The window stretches to six years if you underreported income by more than 25%, seven years for bad-debt or worthless-securities claims, and indefinitely for a fraudulent or unfiled return. Electronic copies count. Expense keeps the receipt image attached to every expense and exports it with the report, so the archive builds itself.`,
  },
  {
    question: "What does the IRS require for a mileage log?",
    answer: `An adequate record shows the miles driven, the date, the destination, and the business purpose of each trip; a year of drives reconstructed from memory does not qualify. For travel expenses generally, the IRS wants documentation for anything $75 or more, plus lodging receipts no matter the amount. Expense logs every drive from the map with its date, route, and applied rate, and keeps that record attached to the expense.`,
  },
  {
    question: "What happens if I upload the same receipt twice?",
    answer: `You will get a visual warning and you can discard it or mark as "not a duplicate". This covers re-uploaded file and sending the same email twice; every stored image also carries a SHA-256 fingerprint, so the same file arriving by a different route is caught too.`,
  },
  {
    question: "Can I reconcile my expenses against a credit card statement?",
    answer: `Yes. Upload a credit card or bank statement in PDF, CSV, QuickBooks (QFX/OFX), or Excel format, and Expense matches every charge against your logged expenses. Any charge without a matching receipt is flagged, so you can spot deductible expenses you missed. You can reconcile multiple statements (across different cards or months), and mixed-use cards are no problem: Expense only cares about matching business expenses. Nothing is written until you confirm which matches to keep and which charges to add as new expenses.`,
  },
  {
    question: "Can I share Expense with my spouse or accountant?",
    answer: `Yes. Share the invitation code, and any new users you invite will see the same expense information. Any other accounts will remain completely separate.`,
  },
  {
    question: "Where is my expense data stored?",
    answer: `On your account only. Expense doesn't serve ads, it doesn't sell your data; receipts and expenses are restricted to your account, and exported as PDF or ZIP anytime you wish.`,
  },
  {
    question: "Is Expense good for freelancers and self-employed people?",
    answer: `It is exactly who Expense was built for. Free until the app reaches 100 users (then still free up to 25 invoices a month), fast receipt capture with OCR and AI categorization, Schedule C categories, reports per clients or projects, map-based mileage using the IRS rate, and easy export for your accountant.`,
  },
  {
    question: "Can I use Expense with an AI assistant?",
    answer: `Yes. Expense supports the Model Context Protocol (MCP) at /mcp. Point any MCP client (e.g. Claude, OpenAI, or some other assistant) to this endpoint and approve the connection signing in with your account. The assistant can then capture receipts (images or PDFs) using the same OCR pipeline as the web app, log mileage, ask about your spending, group expenses into reports, and export a report as a PDF. At any time, you can disconnect any connected app, or revoke its access tokens from Settings. Browsers with WebMCP (Chrome's origin trial) also get the same read tools in-page, using your signed-in session: nothing to connect or configure.`,
  },
  {
    question: "Who makes Expense?",
    answer:
      "Expense is created and maintained by Assaf Arkin (https://labnotes.org).",
  },
];

/** The Expensify comparison, pulled out so /alternatives can cite it. */
const COMPARISON_FAQ: Faq = {
  question: "Can Expense be used as a replacement for Expensify?",
  answer: `Certainly, for personal or small-team expense tracking. Expense is free until the app reaches 100 users (then still free up to 25 invoices a month), reads receipts with OCR, suggests categories, calculates miles based on IRS rate, reconciles credit card statements to catch missed deductions, and arranges all the expenses in Schedule C format and reports for filing taxes. Expensify is a corporate solution (workflows, reimbursements, integration with accounting software) and free tier is limited to 25 SmartScans a month. Expensify paid plans are per user. Expensify is perfect for running a company with employee expense policy, however, if you need your expenses arranged for filing taxes, Expense will do it for you, free while we're early and still free up to 25 invoices a month after.`,
};

/** The full FAQ list: the standalone questions, then the comparison. */
export const FAQS: Faq[] = [...STANDALONE_FAQS, COMPARISON_FAQ];

/** The quotable summary for the comparison page. */
export const COMPARISON_SUMMARY = `How Expense stacks up against the receipt
apps it is most often listed next to: Expensify, Zoho Expense, SparkReceipt,
Shoeboxed, and Wave. Expense is built for one job: getting a private person's
or small team's expenses ready for tax season. It is free while the app is
early (then still free up to 25 invoices a month), reads receipts with OCR,
suggests categories, reconciles credit card statements to catch missed
deductions, and arranges everything in Schedule C format with mileage at the
IRS rate. The apps it gets compared to mostly aim at company expense
management or general bookkeeping; the table below shows who is best for
what.`;

interface CompetitorRow {
  app: string;
  site: string;
  bestFor: string;
  pricing: string;
  taxFiling: string;
}

/** One-row-per-app roundup of the receipt trackers most often listed next
 * to Expense. Numbers come from each vendor's pricing page, checked
 * August 2026, and each cell names the vendor it came from. */
export const COMPETITOR_ROWS: CompetitorRow[] = [
  {
    app: "Expense",
    site: SITE_URL,
    bestFor:
      "Freelancers and individuals getting their expenses ready for tax season.",
    pricing:
      "Free until the app reaches 100 users, then still free up to 25 invoices a month. No ads.",
    taxFiling:
      "IRS Schedule C categories, mileage at the IRS rate, statement reconciliation, PDF or ZIP export for your accountant.",
  },
  {
    app: "Expensify",
    site: "https://www.expensify.com",
    bestFor:
      "Companies with employee expense policies, approval workflows, and reimbursements.",
    pricing:
      "Free tier limited to 25 SmartScans a month; paid plans about $5-$9 per user a month in 2026 (expensify.com).",
    taxFiling:
      "Corporate reimbursement and accounting exports, not personal tax prep.",
  },
  {
    app: "Zoho Expense",
    site: "https://www.zoho.com/expense/",
    bestFor: "Small teams already working in the Zoho suite.",
    pricing:
      "Free for up to 3 users with 20 receipt scans per user a month; Standard is $4 per user a month (zoho.com).",
    taxFiling:
      "Expense reports and accounting integrations, without a Schedule C structure.",
  },
  {
    app: "SparkReceipt",
    site: "https://sparkreceipt.com",
    bestFor: "Solo owners who want AI extraction across many currencies.",
    pricing:
      "No free plan; $99.99 a year (about $8.33 a month) for 3 seats, 7-day trial (sparkreceipt.com).",
    taxFiling:
      "AI categorization that maps to any tax system; currency-global, not tied to a US form.",
  },
  {
    app: "Shoeboxed",
    site: "https://www.shoeboxed.com",
    bestFor:
      "Clearing piles of paper receipts through the mail-in Magic Envelope.",
    pricing:
      "No free plan; Starter is $9 a month with 30 digital scans a month (shoeboxed.com).",
    taxFiling:
      "Audit-ready reports, unlimited mileage tracking, and CSV export.",
  },
  {
    app: "Wave",
    site: "https://www.waveapps.com",
    bestFor: "Invoicing and bookkeeping first, receipts second.",
    pricing:
      "Starter is free but scans no receipts; receipt capture needs Pro at $19 a month (waveapps.com).",
    taxFiling: "General bookkeeping reports rather than a specific tax form.",
  },
];

/** The as-of note shown under the roundup table. */
export const COMPETITOR_PRICING_NOTE =
  "Pricing from each vendor's pricing page, checked August 2026; check the vendor for current numbers.";

// --- IRS mileage rates page (/mileage-rates) --------------------------------

/** One IRS rate period aggregated across types, for the /mileage-rates
 * table and its markdown mirror. Rows come straight from MILEAGE_RATES
 * (the same seed the app syncs into its master table), newest first. */
export interface MileageRateRow {
  period: string;
  start: string;
  end: string;
  business: string;
  medical: string;
  moving: string;
  charity: string;
}

/** All rate periods, newest first. */
export function mileageRateRows(): MileageRateRow[] {
  const byPeriod = new Map<string, MileageRateRow>();
  for (const r of MILEAGE_RATES) {
    const key = `${r.startDate}|${r.endDate}`;
    const row = byPeriod.get(key) ?? {
      period: periodLabel(r.startDate, r.endDate),
      start: r.startDate,
      end: r.endDate,
      business: "",
      medical: "",
      moving: "",
      charity: "",
    };
    row[r.type] = formatRate(r.rate);
    byPeriod.set(key, row);
  }
  return [...byPeriod.values()].toSorted((a, b) =>
    b.start.localeCompare(a.start),
  );
}

function mileagePhrase(row: MileageRateRow): string {
  const [sy, ey] = [row.start.slice(0, 4), row.end.slice(0, 4)];
  if (sy === ey && row.start === `${sy}-01-01` && row.end === `${ey}-12-31`) {
    return `for ${sy}`;
  }
  const monthDay = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  return `from ${monthDay(row.start)} to ${monthDay(row.end)}, ${ey}`;
}

/** The current business/medical/charitable rates as one quotable sentence.
 * Composed from MILEAGE_RATES, not hand-written: when the IRS publishes new
 * rates (usually each December, plus mid-year changes), updating the data
 * file keeps this answer, the FAQ entry, and the page meta description true
 * without a copy edit. */
export function currentMileageSummary(): string {
  const rows = mileageRateRows();
  const latest = rows[0]!;
  const prev = rows[1];
  const split =
    prev !== undefined && prev.end.slice(0, 4) === latest.end.slice(0, 4);
  const business = split
    ? `$${prev.business} per mile ${mileagePhrase(prev)}, then $${latest.business} per mile ${mileagePhrase(latest)}`
    : `$${latest.business} per mile ${mileagePhrase(latest)}`;
  const secondary = split
    ? `medical and moving moves run $${prev.medical} and then $${latest.medical} for the same dates`
    : `medical and moving moves run $${latest.medical}`;
  return `The IRS standard business mileage rate is ${business}; ${secondary}, and the charitable rate is fixed by statute at $${latest.charity}.`;
}

/** One-paragraph hero summary for /mileage-rates, quoted by the page and
 * its markdown mirror. */
export const MILEAGE_PAGE_SUMMARY =
  "The IRS standard mileage rates for every period since 2011 in one table: business, medical, moving, and charitable, including any mid-year changes. Expense uses the same table to compute the mileage deduction from each drive's date and type, so it never asks you to look a rate up.";

function wrap(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// --- AI assistants page (/ai) ---------------------------------------------

/** One-paragraph summary of the MCP integration, quoted by /ai, /ai.md, llms.txt. */
export const AI_SUMMARY =
  "Expense follows the Model Context Protocol (MCP) at https://expense.labnotes.org/mcp. Connect any MCP client like Claude, OpenAI, or some other assistant, then log in via OAuth authentication (no API keys necessary). Your assistant will be able to recognize receipts from photos and PDF files in the same way as the web application does, log drives according to the IRS rate, answer questions about spending based on your data, generate and export reports, and reconcile bank statements with your expenses. In browsers with WebMCP (Chrome's origin trial), Expense also registers in-page read tools for the browser's own agent: same data, your signed-in session, no setup.";

/** The five things an assistant can do (the /ai capability cards). */
export const AI_CAPABILITIES = [
  {
    title: "Capture receipts",
    body: "Upload a photo or PDF of a receipt to the chat and it will OCR and classify it based on your merchant history, just like in the web application—no manual work is required.",
  },
  {
    title: "Log drives in natural language",
    body: `“Log the drive home from the office on Tuesday.” It geocodes, calculates the route, and prices the drive at the IRS rate for the current year.`,
  },
  {
    title: "Answer questions about spending",
    body: `“What amount did I spend on flights last quarter?” The question will get an answer based on your data.`,
  },
  {
    title: "Build and export reports",
    body: `Create or close reports, assign expenses to them, and export a PDF version of the report in one sentence instead of filling out a form.`,
  },
  {
    title: "Reconcile statements",
    body: `Upload the bank statement CSV file and it will find all charges without a receipt. Read-only: no data is written and no receipt is marked as not reconciled.`,
  },
  {
    title: "Tax-season answers",
    body: `The categories match the ones in IRS Schedule C, so a question like “what’s my meals and entertainment total?” maps to your tax form perfectly.`,
  },
];

/** Example prompts shown on /ai. */
export const AI_PROMPTS = [
  "\u201CHere's my receipt, log it under Q3.\u201D",
  "\u201CHow much did I spend on meals and entertainment last quarter?\u201D",
  "\u201CMove all unreported June expenses into the Q2 report and export the PDF.\u201D",
  "\u201CReconcile this statement.\u201D (paste the CSV)",
];

/** How to connect: the numbered steps on /ai. */
export const AI_STEPS = [
  {
    title: "Direct your assistant to the endpoint",
    body: `Tell your assistant to connect to https://expense.labnotes.org/mcp (or just add it to your MCP configuration).`,
  },
  {
    title: "Log in and grant access",
    body: `Your browser window pops up and you authorize your usual account and click Allow on the consent page.`,
  },
  {
    title: "It’s done. You control it anytime",
    body: `Settings → Agents & API (MCP) contains the list of all connected applications; you may remove particular tokens or disconnect completely.`,
  },
];

/** The /ai page's quotable security paragraph. */
export const AI_SECURITY =
  "Connecting is OAuth 2.1 with PKCE: the assistant never sees your password, access tokens live one hour, refresh tokens rotate, and only hashes are stored. A connection only ever reaches your own account. Revoke it anytime in Settings → Agents & API (MCP). Delete a single token or disconnect the whole app.";

/** Full markdown for /ai.md; mirrors the /ai page content. */
export function aiMarkdown(): string {
  const caps = AI_CAPABILITIES.map(
    (c) => `- **${c.title}** — ${wrap(c.body)}`,
  ).join("\n");
  const steps = AI_STEPS.map(
    (s, i) => `${i + 1}. **${s.title}** — ${wrap(s.body)}`,
  ).join("\n");
  return `# ${APP_NAME}: connect your AI assistant

${AI_SUMMARY}

## What your assistant can do

${caps}

## How to connect

${steps}

## Example prompts

${AI_PROMPTS.map((p) => `- ${p}`).join("\n")}

## Security

${AI_SECURITY}

[Create a free account](${SITE_URL}/login?mode=create), free until the app reaches 100 users, then still free up to 25 invoices a month. No ads.
`;
}

// --- MCP connect page (/connect) -------------------------------------------

/** One-paragraph hero summary for /connect, quoted by the page and /connect.md. */
export const MCP_PAGE_SUMMARY =
  "Expense speaks the Model Context Protocol: connect any MCP client (Claude, ChatGPT, Gemini CLI, and others) and it can capture receipts from photos and PDFs, log drives at the IRS rate, answer spending questions from your data, build and export reports, and reconcile bank statements. Connecting is signing in with your Expense account via OAuth; there are no API keys.";

/** Per-client setup instructions, rendered on /connect and mirrored in /connect.md. */
export interface McpClientInstructions {
  id: string;
  name: string;
  /** Compact label for the /connect selector pills; falls back to name. */
  short?: string;
  steps: string[];
  code?: { lang: "sh" | "json" | "toml"; body: string };
  note?: string;
}

export const MCP_CLIENTS: McpClientInstructions[] = [
  {
    id: "claude",
    name: "Claude (claude.ai and Claude Desktop)",
    short: "Claude",
    steps: [
      "Go to claude.ai/customize/connectors",
      'Click the + icon, then "Add custom connector"',
      `Enter the server URL: ${MCP_ENDPOINT}`,
      "Claude opens a browser to sign in to Expense; approve the connection",
    ],
    note: "The connector also appears in Claude Desktop and Claude Code when signed in with the same Claude account.",
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    steps: [
      "Go to Settings > Apps > Advanced settings and enable Developer mode",
      `Click "Create app" and enter the server URL: ${MCP_ENDPOINT}`,
      "Select Developer mode from the Plus menu to use Expense in conversations",
    ],
    note: "Requires a Pro, Plus, Business, Enterprise, or Education plan.",
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    steps: ["Add to ~/.gemini/settings.json:"],
    code: {
      lang: "json",
      body: JSON.stringify(
        { mcpServers: { expense: { httpUrl: MCP_ENDPOINT } } },
        null,
        2,
      ),
    },
  },
  {
    id: "pi",
    name: "Pi",
    steps: [
      "Install the MCP adapter and restart Pi: pi install npm:pi-mcp-adapter",
      "Add to .mcp.json (project) or ~/.config/mcp/mcp.json (global):",
      "Ask for a tool: the first call opens the Expense sign-in, or run /mcp-auth expense.",
    ],
    code: {
      lang: "json",
      body: JSON.stringify(
        { mcpServers: { expense: { url: MCP_ENDPOINT, auth: "oauth" } } },
        null,
        2,
      ),
    },
    note: "Pi has no built-in MCP client by design; pi-mcp-adapter is the community package that adds one.",
  },
  {
    id: "omp",
    name: "Oh My Pi (OMP)",
    short: "Oh My Pi",
    steps: ["Add to ~/.omp/agent/mcp.json (user) or .omp/mcp.json (project):"],
    code: {
      lang: "json",
      body: JSON.stringify(
        { mcpServers: { expense: { type: "http", url: MCP_ENDPOINT } } },
        null,
        2,
      ),
    },
    note: "Or run /mcp add in a session. OMP opens the Expense sign-in when the server asks for auth; /mcp reauth expense re-approves later.",
  },
  {
    id: "other",
    name: "Anything else",
    short: "Other",
    steps: [
      "Any MCP client with Streamable HTTP transport works: point it at the server URL above.",
      "The client discovers the OAuth flow automatically via /.well-known/oauth-authorization-server and opens the Expense sign-in; approve once and consent is remembered.",
    ],
  },
];

/** One-line tool descriptions for /connect; docs/mcp.md stays the operational reference. */
export const MCP_TOOLS: Array<{
  name: string;
  writes: boolean;
  what: string;
}> = [
  {
    name: "capture_receipt",
    writes: true,
    what: "Capture a receipt from an image or PDF (file data or URL): extraction pipeline, stores the image, creates the expense.",
  },
  {
    name: "log_mileage",
    writes: true,
    what: "Log a driving trip from ordered stops; geocodes, routes, and prices it at the IRS rate.",
  },
  {
    name: "list_expenses",
    writes: false,
    what: "Query expenses by date range, category, merchant, report, or type.",
  },
  {
    name: "expense_summary",
    writes: false,
    what: 'Totals and per-category breakdown: the "how much did I spend on X?" tool.',
  },
  {
    name: "list_reports",
    writes: false,
    what: "Reports with expense counts and exact totals.",
  },
  {
    name: "create_report",
    writes: true,
    what: "Create a report (fails if the name exists).",
  },
  {
    name: "close_report",
    writes: true,
    what: "Close (or reopen) a report; closed reports refuse new expenses.",
  },
  {
    name: "add_to_report",
    writes: true,
    what: "Move an expense into an open report.",
  },
  {
    name: "export_report",
    writes: false,
    what: "Render a report as a PDF (same layout as the web export) and return it base64-encoded.",
  },
  {
    name: "list_categories",
    writes: false,
    what: "The account's categories; use these when categorizing.",
  },
  {
    name: "list_merchants",
    writes: false,
    what: "Merchant names previously used, most recent first.",
  },
  {
    name: "get_settings",
    writes: false,
    what: "Home address and the IRS mileage-rate table.",
  },
  {
    name: "reconcile",
    writes: false,
    what: "Match a bank statement (CSV/QFX/OFX) against logged expenses; pure analysis, writes nothing.",
  },
];

/** Full markdown for /connect.md; mirrors the /connect page content. */
export function connectMarkdown(): string {
  const tools = MCP_TOOLS.map(
    (t) => `| \`${t.name}\` | ${t.writes ? "yes" : "no"} | ${t.what} |`,
  ).join("\n");
  const clients = MCP_CLIENTS.map((c) => {
    const steps = c.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
    const code = c.code
      ? `\n\n\`\`\`${c.code.lang}\n${c.code.body}\n\`\`\``
      : "";
    const note = c.note ? `\n\n${c.note}` : "";
    return `### ${c.name}\n\n${steps}${code}${note}`;
  }).join("\n\n");
  return `# Connect your AI assistant to Expense: the MCP server

${MCP_PAGE_SUMMARY}

The base MCP server address is ${MCP_ENDPOINT} (Streamable HTTP + OAuth). All connections use OAuth: the first connection opens a sign-in flow to your Expense account; there are no API keys.

## Tools

| Tool | Writes | What it does |
| --- | --- | --- |
${tools}

## Setup instructions

${clients}

## Security

${AI_SECURITY}

For the browser-based in-page tools (WebMCP), see [${APP_NAME}: connect your AI assistant](${SITE_URL}/ai.md).
`;
}

/** Full markdown for /about.md. Mirrors the /about page content. */
export function aboutMarkdown(): string {
  const benefits = BENEFITS.map(
    (b) => `- **${b.title}** — ${wrap(b.body)}`,
  ).join("\n");
  const facts = KEY_FACTS.map((f) => `- ${wrap(f)}`).join("\n");
  return `# ${APP_NAME}: a free expense tracker built for tax season

${APP_SUMMARY}

${APP_TAGLINE}.

## What you get

${benefits}

## Key facts

${facts}

Built by ${AUTHOR_NAME} (${BLOG_URL}).
`;
}

/** Full markdown for /faq.md; mirrors the /faq page content. */
export function faqMarkdown(): string {
  const qa = FAQS.map((f) => `## ${f.question}\n\n${wrap(f.answer)}`).join(
    "\n\n",
  );
  return `# ${APP_NAME}: frequently asked questions

${APP_SUMMARY}

${qa}

[Create a free account](${SITE_URL}/login?mode=create), free until the app reaches 100 users, then still free up to 25 invoices a month. No ads.
`;
}

/** Full markdown for /alternatives.md. Mirrors the /alternatives page. */
export function alternativesMarkdown(): string {
  const competitorRows = COMPETITOR_ROWS.map(
    (r) =>
      `- **${r.app}** (${r.site}): ${wrap(r.bestFor)} Pricing: ${wrap(r.pricing)} Tax-filing focus: ${wrap(r.taxFiling)}`,
  ).join("\n");
  return `# How ${APP_NAME} compares to the other receipt apps

${COMPARISON_SUMMARY}

## Expense and the other receipt apps

${competitorRows}

${COMPETITOR_PRICING_NOTE}

${APP_NAME} (${SITE_URL}) is free, uses OCR and AI to categorize receipts, tracks
mileage at the IRS rate, and organizes expenses into Schedule C-based
categories and reports for tax filing.

[Create a free account](${SITE_URL}/login?mode=create).
`;
}

/** Full markdown for /mileage-rates.md; mirrors the /mileage-rates page. */
export function mileageRatesMarkdown(): string {
  const rows = mileageRateRows();
  const latest = rows[0]!;
  const table = [
    "| Period | Business | Medical | Moving | Charity |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.period} | $${r.business} | $${r.medical} | $${r.moving} | $${r.charity} |`,
    ),
  ].join("\n");
  return `# IRS standard mileage rates by year

> ${wrap(MILEAGE_PAGE_SUMMARY)}

${wrap(`Reimbursement and deduction rates per mile, newest first. A rate is
effective for its whole period; mid-year changes appear as two rows for the
same year.`)}

${table}

${wrap(`Source: [IRS standard mileage rates](https://www.irs.gov/tax-professionals/standard-mileage-rates).
The moving rate applies only to Armed Forces and Intelligence Community members
moving under orders, and the charitable rate is fixed by statute. [${APP_NAME}](${SITE_URL}/)
applies these rates automatically: each drive's deduction follows its date and
type, with no configuration. Current through ${latest.period}.`)}
`;
}

/** The /llms.txt file: a curated overview for LLM retrieval, per llmstxt.org. */
export function llmsTxt(): string {
  return `# ${APP_NAME}

> ${APP_SUMMARY}

Key facts:

${KEY_FACTS.map((f) => `- ${wrap(f)}`).join("\n")}

## Core pages

- [${APP_NAME}: every receipt, ready for tax season](${SITE_URL}/): The home page; free account signup.
- [About ${APP_NAME}](${SITE_URL}/about.md): What the app does and the full feature list.
- [Frequently asked questions](${SITE_URL}/faq.md): Answers to common questions, including how ${APP_NAME} compares to Expensify.
- [IRS standard mileage rates by year](${SITE_URL}/mileage-rates.md): The rate table for business, medical, moving, and charity drives by period, 2011 to today, including mid-year changes. Expense applies the right rate to each drive automatically.
- [How ${APP_NAME} compares to the other receipt apps](${SITE_URL}/alternatives.md): Where Expense fits among Expensify, Zoho Expense, SparkReceipt, Shoeboxed, and Wave: pricing and tax-filing focus.
- [Connect your AI assistant (MCP server)](${SITE_URL}/connect.md): Setup instructions for every MCP client (Claude, ChatGPT, Gemini CLI, Pi, OMP), the full tool list, and example usage. The MCP endpoint is ${SITE_URL}/mcp (Streamable HTTP + OAuth).
- [Connect your AI assistant](${SITE_URL}/ai.md): What an assistant can do with your account and how to connect: capture receipts, log mileage, answer spending questions, build reports, reconcile statements.

## Optional

- [Blog](${BLOG_URL}): Posts by the author.
`;
}
