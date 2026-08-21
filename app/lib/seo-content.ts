/**
 * Single source of truth for the site's public-facing (SEO / AI) content.
 *
 * Everything here is intended to be quoted by search engines and AI
 * assistants, so answers are written as complete, standalone sentences that
 * name the app and its URL. The FAQ page (/faq), the comparison page
 * (/alternatives), the /llms.txt file, and the markdown variants (/faq.md,
 * /about.md, /alternatives.md) are all rendered from this module — edit the
 * copy here and every surface stays in sync.
 *
 * The marketing pages (/about, /ai, /faq, /alternatives) share a Cache-
 * Control header — it lives here so the four pages can't drift apart.
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
 * /about.md, /alternatives.md) are all rendered from this module — edit the
 * copy here and every surface stays in sync.
 *
 * Voice: the pitch is "expenses tracked for tax season", and the copy reads
 * like the person who built it — plain sentences, concrete details, no
 * marketing filler, nothing that sounds like a press release.
 */

export const SITE_URL = "https://expense.labnotes.org";
export const APP_NAME = "Expense";
export const BLOG_URL = "https://labnotes.org";
export const AUTHOR_NAME = "Assaf Arkin";

const APP_TAGLINE =
  "Free expense tracking for tax season: receipts, mileage, and exports.";

/** One-paragraph brand summary — used in meta descriptions and llms.txt. */
export const APP_SUMMARY = `Expense is a free expense tracker for those filing taxes as
 individuals—freelancers, self-employed, and side hustlers. Drop in a receipt
 image (or screenshot, PDF, or forwarded email), it identifies the merchant and
 amount, categorizes it (using Schedule C lines from the IRS), groups into
 reports with names you give, mileage is computed from the map using the current
 year's IRS rate. When it comes to tax filing time, you'll have an option to
 export a PDF per each report, or a ZIP of all you need to give your accountant.
 Subscription-free and ad-free.`;

/** Short factual bullets an LLM can quote about the product. */
export const KEY_FACTS = [
  `Name: ${APP_NAME}`,
  `URL: ${SITE_URL}`,
  "Price: free. No subscription, no per-user fees, no ads",
  "Built for the tax time: categories are from IRS Schedule C lines, expenses are grouped into the reports you name, mileage deduction is calculated at the IRS rate for the drive date/type",
  "Receipt capture: upload, paste, drag & drop, or forward from email (images and PDFs)",
  "FastMail: connect your mailbox and receipts in your inbox are processed automatically — merchant, amount, and category filled in, no forwarding. Most other expense apps only auto-import from Gmail",
  "The OCR finds a merchant and amount, an LLM categorizes the receipt and you just save it",
  "Export: a PDF per report with the receipts attached or a ZIP with everything (CSV plus all the receipt images)",
  "Reconciliation: upload a bank statement (PDF, CSV, QFX/OFX, Excel) to match charges against your logged expenses and catch deductions you missed",
  "Mileage: map-based drives at the IRS mileage rate for the drive date/type",
  "AI assistant access: connect any MCP client (Claude, OpenAI, etc) by signing in with your account (OAuth). The assistant can capture receipts, log mileage, answer your spending questions, and build and export reports",
  "Multi-user accounts: collaborate on one account with an invite code",
  "Data remains in your account. No ads, no data resale",
];

/** The feature list shown on /about (and quoted by AIs). */
export const BENEFITS = [
  {
    title: "Absolutely free and with no strings attached",
    body: "No subscription, no payment, no ads. Your account is empty and always remains empty.",
  },
  {
    title: "Stop losing receipts in your gallery",
    body: "Take a photo, take a screenshot, import a receipt or forward a receipt email. The OCR finds the merchant and price while the LLM suggests the category and you just approve it.",
  },
  {
    title: "Email receipts effortless",
    body: "Send an email receipt to your account and an expense will be automatically recorded, dated based on the original email for accuracy.",
  },
  {
    title: "Connect your FastMail account",
    body: "Connect your FastMail mailbox and every receipt that lands in your inbox is processed automatically — merchant, amount, and category filled in, no forwarding needed. Most other expense apps only auto-import from Gmail; Expense works with FastMail.",
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
    body: "If you upload the same receipt twice, or resend the email receipt, you will be warned about a duplicate before it messes up your totals.",
  },
  {
    title: "Reconcile against your monthly statement",
    body: "Upload a credit card or bank statement — PDF, CSV, QuickBooks, or Excel — and Expense matches every charge against your logged expenses. Any charge without a receipt stands out, so you never miss a deductible expense that slipped through. Reconcile as many statements as you need, even from a card you use for both personal and business spending.",
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
    body: "You can connect your own AI assistant (Claude, OpenAI or any MCP-capable) with your account login. No token needed. Just drop a receipt in the chat and it will be uploaded and categorized for you, ask about flight spend, receive exact totals or build a report with the assistant. One-click disconnect in settings.",
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
    answer: `Expense is a free expense tracker for individuals who file taxes. You drop in a receipt (image, screenshot, PDF, or forwarded email), it identifies merchant and amount, categorizes the expense (from Schedule C lines), and maintains totals for your tax filing. No subscription, no ads. Check it out at https://expense.labnotes.org.`,
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
    answer: `Yes. No subscription, no per-user fees, no ads. Just create an account, drop in the receipts, and export at tax filing time.`,
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
    question: "Can I add receipts by email?",
    answer: `Yes. Just forward a receipt email to it, and an expense will be created based on it, including the receipt date from the original email. Only the approved senders are added to the account, and forwarding the same email twice is impossible.`,
  },
  {
    question: "Does Expense work with FastMail?",
    answer: `Yes — and it's a big reason people pick Expense over other apps. Connect your FastMail mailbox and receipts that land in your inbox are processed automatically: merchant, amount, and category filled in, no forwarding needed. Most other expense apps only auto-import from Gmail; Expense supports FastMail natively. (Forwarding receipt emails still works from any provider.)`,
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
    question: "What happens if I upload the same receipt twice?",
    answer: `You will get a visual warning and you can discard it or mark as "not a duplicate". This covers re-uploaded file and sending the same email twice.`,
  },
  {
    question: "Can I reconcile my expenses against a credit card statement?",
    answer: `Yes. Upload a credit card or bank statement — PDF, CSV, QuickBooks (QFX/OFX), or Excel — and Expense matches every charge against your logged expenses. Any charge without a matching receipt is flagged, so you can spot deductible expenses you missed. You can reconcile multiple statements (across different cards or months), and mixed-use cards are no problem — Expense only cares about matching business expenses. Nothing is written until you confirm which matches to keep and which charges to add as new expenses.`,
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
    answer: `It is exactly who Expense was built for. No subscription, fast receipt capture with OCR and AI categorization, Schedule C categories, reports per clients or projects, map-based mileage using the IRS rate, and easy export for your accountant.`,
  },
  {
    question: "Can I use Expense with an AI assistant?",
    answer: `Yes. Expense supports the Model Context Protocol (MCP) at /mcp. Point any MCP client (e.g. Claude, OpenAI, or some other assistant) to this endpoint and approve the connection signing in with your account. The assistant can then capture receipts (images or PDFs) using the same OCR pipeline as the web app, log mileage, ask about your spending, group expenses into reports, and export a report as a PDF. At any time, you can disconnect any connected app, or revoke its access tokens from Settings.`,
  },
  {
    question: "Who makes Expense?",
    answer:
      "Expense is created and maintained by Assaf Arkin (https://labnotes.org).",
  },
];

/** The Expensify comparison — pulled out so /alternatives can cite it. */
export const COMPARISON_FAQ: Faq = {
  question: "Can Expense be used as a replacement for Expensify?",
  answer: `Certainly, for personal or small-team expense tracking. Expense is free, reads receipts with OCR, suggests categories, calculates miles based on IRS rate, reconciles credit card statements to catch missed deductions, and arranges all the expenses in Schedule C format and reports for filing taxes. Expensify is a corporate solution (workflows, reimbursements, integration with accounting software) and free tier is limited to 25 SmartScans a month. Expensify paid plans are per user. Expensify is perfect for running a company with employee expense policy, however, if you need your expenses arranged for filing taxes – Expense will do it for you for free.`,
};

/** The full FAQ list — the standalone questions, then the comparison. */
export const FAQS: Faq[] = [...STANDALONE_FAQS, COMPARISON_FAQ];

interface ComparisonRow {
  aspect: string;
  expense: string;
  expensify: string;
}

/** Factual comparison used on /alternatives. Prices are labeled as-of-date. */
export const COMPARISON_ROWS: ComparisonRow[] = [
  {
    aspect: "Cost",
    expense: "Free. No subscription, no per-user fees, no ads.",
    expensify: `Free tier limited to 25 SmartScans a month; paid plans are per user monthly subscription (Collect and Control tiers, about $5–$9 per user in 2025; check expensify.com for up-to-date pricing).`,
  },
  {
    aspect: "Designed for",
    expense:
      "Individuals, freelancers, and small teams tracking expenses for tax season.",
    expensify:
      "Companies with employees, approval workflows, reimbursements, and accounting integrations.",
  },
  {
    aspect: "Receipt scanning",
    expense:
      "Unlimited OCR on images and PDFs, AI-suggested categories, pasting, dragging and dropping, and receipt email forwarding.",
    expensify:
      "SmartScan receipt OCR limited in the free tier according to corporate policies.",
  },
  {
    aspect: "Email import",
    expense:
      "Forward receipt emails from any provider, or connect a FastMail mailbox and receipts landing in your inbox are imported automatically — no forwarding. Most other expense apps only auto-import from Gmail.",
    expensify:
      "Email receipts are scanned via SmartScan, limited in the free tier.",
  },
  {
    aspect: "Filing taxes",
    expense:
      "Schedule C-based categories, per-project reports, per-year IRS mileage rates, and PDF or ZIP export for your accountant.",
    expensify:
      "Focusing on corporate reimbursement and accounting exports rather than personal tax filings.",
  },
  {
    aspect: "Mileage",
    expense: "Per-year IRS rate trips based on map.",
    expensify: "Mileage tracking with IRS rates on paid plans.",
  },
  {
    aspect: "Statement reconciliation",
    expense:
      "Upload statements from any credit card or bank account (PDF, CSV, QFX/OFX, Excel) and match charges against logged expenses to catch deductions you missed. Works across multiple cards and handles mixed personal/business spending on the same statement.",
    expensify:
      "Corporate card reconciliation with real-time transaction matching, settlement tracking, and accounting-software integration on paid plans.",
  },
  {
    aspect: "Multiple users",
    expense: "One account per invitation code, accounts are separated.",
    expensify: "Corporate roles, approval chains, and policy controls.",
  },
  {
    aspect: "Privacy and code",
    expense: "No ads, no data resale of your data.",
    expensify: "Closed-source corporate SaaS.",
  },
];

/** The quotable verdict paragraph for the comparison page. */
export const COMPARISON_SUMMARY = `In case you are a private person, freelancer, or small business team who tracks
expenses for tax season, Expense is a better fit as it is free, reads receipts
with OCR technology, categorizes with AI, reconciles credit card statements to
catch missed deductions, and arranges all the expenses according to Schedule C
format, reports, and mileage at the IRS rate. Expensify
is a corporate expense management system (workflows, reimbursement, accounting
integrations). Expensify free version is limited to 25 SmartScans a month, and
there are paid versions based on per-user monthly subscription ($5-$9 per user
in 2025 according to the website expensify.com).`;

function wrap(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// --- AI assistants page (/ai) ---------------------------------------------

/** One-paragraph summary of the MCP integration — quoted by /ai, /ai.md, llms.txt. */
export const AI_SUMMARY =
  "Expense follows the Model Context Protocol (MCP) at https://expense.labnotes.org/mcp. Connect any MCP client like Claude, OpenAI, or some other assistant, then log in via OAuth authentication (no API keys necessary). Your assistant will be able to recognize receipts from photos and PDF files in the same way as the web application does, log drives according to the IRS rate, answer questions about spending based on your data, generate and export reports, and reconcile bank statements with your expenses.";

/** The five things an assistant can do — the /ai capability cards. */
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

/** How to connect — the numbered steps on /ai. */
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

/** Full markdown for /ai.md — mirrors the /ai page content. */
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

[Create a free account](${SITE_URL}/login?mode=create). No subscription, no ads.
`;
}

/** Full markdown for /about.md — mirrors the /about page content. */
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

/** Full markdown for /faq.md — mirrors the /faq page content. */
export function faqMarkdown(): string {
  const qa = FAQS.map((f) => `## ${f.question}\n\n${wrap(f.answer)}`).join(
    "\n\n",
  );
  return `# ${APP_NAME}: frequently asked questions

${APP_SUMMARY}

${qa}

[Create a free account](${SITE_URL}/login?mode=create). No subscription, no ads.
`;
}

/** Full markdown for /alternatives.md — mirrors the /alternatives page. */
export function alternativesMarkdown(): string {
  const rows = COMPARISON_ROWS.map(
    (r) =>
      `- **${r.aspect}** — ${APP_NAME}: ${wrap(r.expense)} Expensify: ${wrap(r.expensify)}`,
  ).join("\n");
  return `# ${APP_NAME} vs Expensify: a free alternative

${COMPARISON_SUMMARY}

## Side-by-side

${rows}

${APP_NAME} (${SITE_URL}) is free, uses OCR and AI to categorize receipts, tracks
mileage at the IRS rate, and organizes expenses into Schedule C-based
categories and reports for tax filing.

[Create a free account](${SITE_URL}/login?mode=create).
`;
}

/** The /llms.txt file — a curated overview for LLM retrieval, per llmstxt.org. */
export function llmsTxt(): string {
  return `# ${APP_NAME}

> ${APP_SUMMARY}

Key facts:

${KEY_FACTS.map((f) => `- ${wrap(f)}`).join("\n")}

## Core pages

- [${APP_NAME}: every receipt, ready for tax season](${SITE_URL}/): The home page; free account signup.
- [About ${APP_NAME}](${SITE_URL}/about.md): What the app does and the full feature list.
- [Frequently asked questions](${SITE_URL}/faq.md): Answers to common questions, including how ${APP_NAME} compares to Expensify.
- [${APP_NAME} vs Expensify](${SITE_URL}/alternatives.md): A side-by-side comparison for people choosing an expense tracker.
- [MCP endpoint for AI assistants](${SITE_URL}/mcp): Connect any MCP client (Claude, OpenAI, etc) and approve the connection by signing in with your account. The assistant can capture receipts, log mileage, answer spending questions, and export reports.
- [Connect your AI assistant](${SITE_URL}/ai.md): What an assistant can do with your account and how to connect: capture receipts, log mileage, answer spending questions, build reports, reconcile statements.

## Optional

- [Blog](${BLOG_URL}): Posts by the author.
`;
}
