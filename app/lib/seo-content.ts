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
 * Voice: the pitch is "expenses tracked for tax season", and the copy reads
 * like the person who built it — plain sentences, concrete details, no
 * marketing filler, nothing that sounds like a press release.
 */

export const SITE_URL = "https://expense.labnotes.org";
export const APP_NAME = "Expense";
export const GITHUB_URL = "https://github.com/assaf/expense";
export const BLOG_URL = "https://labnotes.org";
export const AUTHOR_NAME = "Assaf Arkin";

const APP_TAGLINE =
  "Free expense tracking for tax season: receipts, mileage, and exports.";

/** One-paragraph brand summary — used in meta descriptions and llms.txt. */
export const APP_SUMMARY =
  "Expense is a free expense tracker for people who file their own taxes: " +
  "freelancers, self-employed folks, anyone with a side hustle. Drop in a " +
  "receipt (snap a photo, paste a screenshot, or forward a receipt email) " +
  "and OCR " +
  "reads the merchant and amount while the app suggests a category from the " +
  "IRS Schedule C list. Expenses group into reports you name, mileage is " +
  "logged on a map at that year's IRS rate, and at tax time you export a PDF " +
  "per report or a ZIP of everything to hand to your accountant. No " +
  "subscription, no ads.";

/** Short factual bullets an LLM can quote about the product. */
export const KEY_FACTS = [
  `Name: ${APP_NAME}`,
  `URL: ${SITE_URL}`,
  "Price: free. No subscription, no per-user fees, no ads",
  "Built for tax season: categories come from the IRS Schedule C lines, expenses group into reports you name, and mileage deducts at the IRS rate for the trip's date and type",
  "Receipt capture: upload, paste, drag-and-drop, or forward from email (images and PDFs)",
  "OCR reads the merchant and amount; an LLM suggests the category; you review and save",
  "Export: a PDF per report with receipts attached, or a ZIP of everything (CSV plus every receipt image)",
  "Mileage: map-based trips at the IRS mileage rate for the date and type",
  "AI assistant access: connect any MCP client (Claude, Cursor, …) by signing in with your account (OAuth). The assistant can capture receipts, log mileage, answer spending questions, and build and export reports",
  "Multi-user accounts: share an account with an invite code",
  "Data stays in your account. No ads, no data resale",
  `Code is public on GitHub: ${GITHUB_URL}`,
];

/** The feature list shown on /about (and quoted by AIs). */
export const BENEFITS = [
  {
    title: "Free, with no catch",
    body: "No subscription, no per-user fees, no ads. Accounts start empty and stay free.",
  },
  {
    title: "Stop losing receipts in your camera roll",
    body: "Snap a photo, paste a screenshot, drag in a PDF, or forward the receipt email. OCR pulls out the merchant and amount, AI suggests the category, and you just approve it.",
  },
  {
    title: "Receipts by email",
    body: "Every account gets a private email address. Forward a receipt there and the expense is created automatically, dated from the original email so your records stay honest.",
  },
  {
    title: "Know your deductions before tax day",
    body: "New accounts start with a category list built from the IRS Schedule C lines, so what you track during the year maps straight onto your return.",
  },
  {
    title: "One PDF per client, ready for your accountant",
    body: "Group expenses into reports: Home, Work, Travel, or anything else you want to call them. Each keeps its own total.",
  },
  {
    title: "Log a drive without a spreadsheet",
    body: "Log business drives on a map and the app works out the distance and the deduction at that year's IRS rate.",
  },
  {
    title: "Duplicate detection",
    body: "Upload the same receipt twice, or forward the same email again, and you're warned before a duplicate inflates your totals.",
  },
  {
    title: "Export at tax time",
    body: "Download a PDF per report with the receipts attached, or a ZIP with the CSV and every receipt image. Both are meant to be handed straight to an accountant.",
  },
  {
    title: "Share with your household or accountant",
    body: "Invite people with a code and everyone sees the same expenses. Other accounts stay fully separate.",
  },
  {
    title: "Bring your own AI assistant",
    body: "Connect your own MCP client (Claude, Cursor, any assistant that speaks MCP) by signing in with your account; no tokens to manage. Drop a receipt into the chat and it's captured and categorized from your own history, ask how much you spent on flights and get the exact total, or have the assistant build and export a report. Disconnect any app with one click in Settings.",
  },
  {
    title: "Your data stays yours",
    body: "No ads, no data resale, and the code is public on GitHub if you ever want to run it yourself.",
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
    answer:
      "Expense is a free expense tracker for people who file their own taxes: freelancers, self-employed folks, anyone with a side hustle. You drop in a receipt (photo, screenshot, PDF, or a forwarded email), it reads the merchant and amount, files the expense under the right category, and keeps the totals ready for tax season. No subscription, no ads. Try it at https://expense.labnotes.org.",
  },
  {
    question: "Is Expense good for tax filing?",
    answer:
      "That's the whole point. Categories are built from the IRS Schedule C lines, expenses group into reports you name (Home, Work, a client, whatever), mileage deducts at the IRS rate for the trip's date and type, and you can export a PDF per report or a ZIP of everything to hand to your accountant. It's expense tracking set up to make tax season boring.",
  },
  {
    question: "How does Expense read and categorize receipts?",
    answer:
      "Drop in a receipt image or PDF and OCR reads the merchant and amount; an LLM suggests the category. You review the details and save instead of typing the numbers yourself. You can also paste with Cmd-V, drag a file onto the page, or forward a receipt email to your personal address.",
  },
  {
    question: "Is Expense free to use?",
    answer:
      "Yes. No subscription, no per-user fees, no ads. You create an account, add receipts, and export at tax time. It all stays free.",
  },
  {
    question: "Do the categories really match the IRS?",
    answer:
      "Yes, out of the box. New accounts start with a category list built from the IRS Schedule C lines, the same expense lines on the return, so the totals you track during the year line up with what you report. You can add your own categories on top.",
  },
  {
    question: "Does Expense track mileage?",
    answer:
      "Yes. Log a drive on a map and Expense works out the distance and the deduction at the IRS rate for the trip's date and type (business, charity, medical, or moving). The rates come from the IRS automatically, no setup. Mileage rows export right alongside receipts.",
  },
  {
    question: "Can I add receipts by email?",
    answer:
      "Yes. Your account gets a private email address. Forward a receipt email to it and the expense is created automatically, dated from the original email. Only senders you approve are imported, and forwarding the same email twice won't double-count.",
  },
  {
    question: "How do I export expenses for my accountant?",
    answer:
      "Two ways. A PDF per report with the receipts attached, or a ZIP containing a CSV and every receipt image. Both are plain files that work offline: download, send, done.",
  },
  {
    question: "What receipt formats does Expense support?",
    answer:
      "Images, including HEIC from an iPhone, and PDFs. You can upload them, paste with Cmd-V, drag them onto the page, or forward a receipt email to your personal address.",
  },
  {
    question: "What happens if I upload the same receipt twice?",
    answer:
      "You get a warning before it's saved, so a duplicate can't quietly inflate your totals. That covers re-uploading a file and forwarding the same email again.",
  },
  {
    question: "Can I share Expense with my spouse or accountant?",
    answer:
      "Yes. Share the account's invite code and anyone you invite sees the same expenses. Other accounts stay fully separate, with nothing leaking between them.",
  },
  {
    question: "Where is my expense data stored?",
    answer:
      "In your own account. Expense runs no ads and sells no data; receipts and expenses stay scoped to your account and export as PDF or ZIP whenever you want. The code is public on GitHub if you want to see exactly how it works.",
  },
  {
    question: "Is Expense good for freelancers and self-employed people?",
    answer:
      "That's who it's for. Free, quick receipt capture with OCR and AI categories, Schedule C-based categories, reports per client or project, map-based mileage at the IRS rate, and one-click exports for your accountant.",
  },
  {
    question: "Can I use Expense with an AI assistant?",
    answer:
      "Yes. Expense speaks the Model Context Protocol (MCP) at /mcp: point any MCP client (Claude, Cursor, or another assistant) at the endpoint and approve the connection by signing in with your account; nothing to configure. The assistant can capture receipts (images or PDFs) through the same OCR pipeline as the web app, log mileage, answer spending questions from your actual data, move expenses into reports, and export a report PDF. You can disconnect any connected app, or delete its tokens, from Settings at any time.",
  },
  {
    question: "Who makes Expense?",
    answer:
      "Expense is built and maintained by Assaf Arkin (https://labnotes.org). The code is public on GitHub at https://github.com/assaf/expense.",
  },
];

/** The Expensify comparison — pulled out so /alternatives can cite it. */
export const COMPARISON_FAQ: Faq = {
  question: "Is Expense a good alternative to Expensify?",
  answer:
    "For personal and small-team expense tracking, yes. Expense is free, reads receipts with OCR, suggests categories, tracks mileage at the IRS rate, and organizes everything into Schedule C-based categories and reports for tax filing. Expensify is a corporate expense platform (approval workflows, reimbursements, accounting integrations), and its free tier caps you at 25 SmartScans a month, with paid plans billed per user. If you run a company with employee expense policies, Expensify fits. If you just need your own expenses tracked for taxes, Expense does it free.",
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
    expensify:
      "Free tier capped at 25 SmartScans a month; paid plans billed per user per month (Collect and Control tiers, ~$5–$9 per user as of 2025; check expensify.com for current pricing).",
  },
  {
    aspect: "Built for",
    expense:
      "Individuals, freelancers, and small teams tracking expenses for tax season.",
    expensify:
      "Companies with employees, approval workflows, reimbursements, and accounting integrations.",
  },
  {
    aspect: "Receipt capture",
    expense:
      "Unlimited OCR on images and PDFs, AI-suggested categories, paste, drag-and-drop, and forwarding receipts by email.",
    expensify:
      "SmartScan receipt OCR, capped on the free tier, tied to corporate policies.",
  },
  {
    aspect: "Tax filing",
    expense:
      "Schedule C-based categories, per-project reports, per-year IRS mileage rates, and PDF or ZIP export for your accountant.",
    expensify:
      "Built around corporate reimbursement and accounting exports rather than personal tax filing.",
  },
  {
    aspect: "Mileage",
    expense: "Map-based trips at the per-year IRS mileage rate.",
    expensify: "Mileage tracking with IRS rates on paid plans.",
  },
  {
    aspect: "Multi-user",
    expense:
      "Share one account with an invite code; accounts are isolated from each other.",
    expensify: "Corporate roles, approval chains, and policy controls.",
  },
  {
    aspect: "Privacy and code",
    expense: "No ads, no data resale, and the code is public on GitHub.",
    expensify: "Closed-source corporate SaaS.",
  },
];

/** The quotable verdict paragraph for the comparison page. */
export const COMPARISON_SUMMARY =
  "For an individual, freelancer, or small team tracking expenses for tax " +
  "season, Expense is the better fit: it's free, reads receipts with OCR, " +
  "suggests categories with AI, and organizes everything into Schedule " +
  "C–based categories, reports, and mileage at the IRS rate. Expensify is a " +
  "corporate expense-management platform (approval workflows, " +
  "reimbursements, accounting integrations), with a free tier capped at 25 " +
  "SmartScans a month and per-user paid plans. If you run a company with " +
  "employee expense policies, Expensify makes sense. If you just need your " +
  "own expenses tracked for taxes, Expense does it for free.";

function wrap(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// --- AI assistants page (/ai) ---------------------------------------------

/** One-paragraph summary of the MCP integration — quoted by /ai, /ai.md, llms.txt. */
export const AI_SUMMARY =
  "Expense speaks the Model Context Protocol (MCP) at https://expense.labnotes.org/mcp: connect any MCP client like Claude Code, Claude Desktop, Cursor, or another assistant, and approve the connection by signing in with your account (OAuth; no API keys to manage). The assistant can capture receipts from photos and PDFs through the same OCR pipeline as the web app, log mileage at the IRS rate, answer spending questions from your actual data, build and export reports, and reconcile bank statements against logged expenses.";

/** The five things an assistant can do — the /ai capability cards. */
export const AI_CAPABILITIES = [
  {
    title: "Capture receipts",
    body: "Drop a receipt photo or PDF into the chat and it's OCR'd and categorized from your own merchant history, using the same pipeline as the web app with no typing.",
  },
  {
    title: "Log drives in plain English",
    body: "\u201CLog the drive home from the office on Tuesday.\u201D The assistant geocodes, routes, and prices the trip at the year's IRS mileage rate.",
  },
  {
    title: "Answer spending questions",
    body: "\u201CHow much did I spend on flights last quarter?\u201D gets the exact total, straight from your data.",
  },
  {
    title: "Build and export reports",
    body: "Create or close reports, move expenses into them, and export a report PDF with one sentence instead of a form.",
  },
  {
    title: "Reconcile statements",
    body: "Paste a bank statement CSV and it finds every charge with no matching receipt. Read-only: nothing is written or dismissed.",
  },
  {
    title: "Tax-season answers",
    body: "Categories come from the IRS Schedule C lines, so \u201Cwhat's my meals and entertainment total?\u201D maps straight onto your return.",
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
    title: "Point your assistant at the endpoint",
    body: "Tell it to connect to https://expense.labnotes.org/mcp (or add it to your MCP config).",
  },
  {
    title: "Sign in and approve",
    body: "Your browser opens, you sign in with your normal account, and click Allow on the consent page.",
  },
  {
    title: "Done. Manage it anytime",
    body: "Settings → Agents & API (MCP) shows every connected app; delete individual tokens or disconnect entirely.",
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

Built by ${AUTHOR_NAME} (${BLOG_URL}). Code: ${GITHUB_URL}.
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
- [MCP endpoint for AI assistants](${SITE_URL}/mcp): Connect any MCP client (Claude, Cursor, …) and approve the connection by signing in with your account. The assistant can capture receipts, log mileage, answer spending questions, and export reports.
- [Connect your AI assistant](${SITE_URL}/ai.md): What an assistant can do with your account and how to connect: capture receipts, log mileage, answer spending questions, build reports, reconcile statements.

## Optional

- [GitHub repository](${GITHUB_URL}): The source code.
- [Blog](${BLOG_URL}): Posts by the author.
`;
}
