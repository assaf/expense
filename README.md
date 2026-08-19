# Expense

> Expense is a seamless receipt tracking solution: receipts are automatically
> sent via email, mileage uses the tax rate provided by the IRS, and a smart AI
> assistant does your data entry so that you can forget about the process
> altogether.

## Screenshots

![Expense list — reports, receipts, and a mileage route](public/screenshot-home.png)

![Receipt editor with the receipt image](public/screenshot-expense.png)

What it does:

- Log receipt expenses (upload/scan the image, specify the date, report,
  category, merchant, amount) and mileage expenses (map a route on the map —
  Leaflet + OSRM — using the per year mileage rate)
- Forward your receipt to the email associated with your Expense account, and
  the receipt will be parsed and automatically added (see below)
- Reports and categories — organize your expenses into; every receipt image is
  saved and automatically renamed to `YYYY-MM-DD_Report_Name.jpg`
- Export — as a PDF (one PDF per report with receipt images attached) and a ZIP
  archive

Stack:

- React Router v8 (framework mode) + Tailwind v4, TypeScript
- Postgres via Prisma — accounts, users, expenses, reports, categories,
  settings, mileage, image blobs
- Images: Postgres BYTEA (production and development/test) — no external storage
- Deployed on Vercel + Supabase Postgres (git push to main automatically
  deploys)

Auth and accounts:

- Email/password login (hashed with scrypt), sessions with signed cookies
- Multi-user accounts: everything in one account is shared between users, each
  account is separate from other ones
- A user can join an account by entering an 8-character invite code (visible in
  Settings) and can sign up to a new account from scratch; image keys are
  namespaced by an account so that two accounts won't interfere

## Accounts and sharing

Email/password login — email is the login name, stored in lowercase and
validated, and unique at signup/join. All expenses, reports, categories, and
settings belong to an account; everything in an account is shared between users,
and accounts are fully isolated from each other.

- **Sign up** -> creates an entirely new account (empty).
- **Join** -> enters an account invite code (Settings -> Account) to join an
  existing account and share its data.
- The first account/user is bootstrapped from `APP_EMAIL`/`APP_PASSWORD` when
  the database is empty; pre-existing accounts get their login restored from
  `APP_EMAIL` on the first launch (initStore).

## SEO and AI discovery

Marketing pages that are available publicly double as the AI search surface: if
an assistant is asked for an expense tracker, the GPTBot / OAI-SearchBot /
ClaudeBot / PerplexityBot crawler quotes them. The copy is written in such a way
that it's easily quotable and includes the app name and the URL and lives only
in one file — `app/lib/seo-content.ts` — which renders all the surfaces:

| Page                                     | Purpose                                                        |
| ---------------------------------------- | -------------------------------------------------------------- |
| `/`                                      | Landing page (SoftwareApplication JSON-LD)                     |
| `/about`                                 | Full feature/benefit list (AboutPage JSON-LD)                  |
| `/faq`                                   | 13 Q&As matching real AI queries (FAQPage JSON-LD)             |
| `/alternatives`                          | Expense vs Expensify comparison (WebPage + FAQPage JSON-LD)    |
| `/llms.txt`                              | The llmstxt.org file — the curated overview AI assistants read |
| `/about.md` `/faq.md` `/alternatives.md` | Markdown mirrors per the llms.txt convention                   |

Plumbing to support it: `public/robots.txt` explicitly permits the AI crawlers
while app routes are blocked, and `public/sitemap.xml` lists the public pages.

These routes are public (see the root loader in `app/root.tsx`); everything
else still requires a session.

## What it does

- Track **receipt** expenses (date, merchant, amount, image, category, report)
  and **mileage** expenses (date, 2+ addresses, distance, amount, report).
- Mileage routes run **Home → stops → Home**; distance is calculated using OSRM
  and the amount based on a per-year mileage rate. Maps is powered by Leaflet +
  OpenStreetMap — **no API keys necessary**.
- Incomplete expenses are highlighted to make it easy to complete them.
- Paste (⌘V) or upload an image anywhere to create a new receipt.
- **Export** each report as a PDF (grouped by category, with all receipt images
  attached) and a ZIP archive (CSV + images named `YYYY-MM-DD_REPORT_FILE.ext`).
- **AI assistants (MCP)**: any MCP client — Claude, OpenAI — can connect by
  logging in with your account (OAuth; no API keys). See [AI
  assistants](#ai-assistants-mcp) below.

## AI assistants (MCP)

The app speaks the Model Context Protocol at `https://expense.labnotes.org/mcp`
(auth: OAuth 2.1 authorization-code + PKCE — sign in and authorize the
connection; no API keys). An assistant linked with to your account can:

- **Upload a receipt** — drag and drop a picture or PDF into chat; it processes
  the same way as the web app and uses the same OCR and extraction as well as
  your merchant history for categorization.
- **Log a drive** — drag and drop stops written in plain English; it geocodes,
  routs, and prices the route according to the year's IRS rates.
- **Answer questions about spending** — for example "how much have I spent on
  flights last quarter?" — you'll receive the answer based on your data.
- **Create reports** — create/close a report, move expenses into it, export
  a report PDF.
- **Reconcile** — upload your bank statement as a CSV; it will match all charges
  without a matching receipt (read-only).

Connect any MCP client:

```json
// Claude — .mcp.json (no headers needed: the client discovers OAuth)
{
  "mcpServers": {
    "expense": {
      "type": "http",
      "url": "https://expense.labnotes.org/mcp"
    }
  }
}
```

The client will open your browser; you'll log in and click Allow. You can manage
connections (delete per token, disconnect completely) in **Settings -> Agents &
API (MCP)**. For the full reference, see [`docs/mcp.md`](docs/mcp.md) and for
directory listings: [`docs/mcp-directories.md`](docs/mcp-directories.md).

## State

The storage is Postgres-only via **Prisma** (`prisma/schema.prisma` is the only
source of truth; the client is built to `prisma/generated` with `pnpm
build:prisma`). `DATABASE_URL` is required upon launch (otherwise the app will
crash with an error). Image blobs are stored inside Postgres BYTEA
(`image_blobs`) in production and development — there is no additional storage
service.

| Data                        | Images                         |
| --------------------------- | ------------------------------ |
| `accounts` / `users` /      | Postgres BYTEA (`image_blobs`, |
| `expenses` / `reports` /    | prod and dev)                  |
| `categories` / `settings` / |                                |
| `mileage` / `image_blobs`   |                                |

All reads/writes are done via `app/lib/database.ts` (Prisma queries scoped by
`accountId`); image storage is handled by `app/lib/images.server.ts` (Prisma
`imageBlob`). Image blobs are kept in `images/{accountId}/...` pathnames on all
backends — they are namespaced per account and thus, two accounts cannot ever
have a name conflict. Schema changes: edit `prisma/schema.prisma`, then run
`prisma migrate dev --name …` locally and `pnpm db:push` (or `pnpm db:migrate`)
before deploy.

## Quick start

## Environment variables

Load order: real `process.env` (Vercel dashboard, or inline) wins; a local
`.env` is used to fill holes. `DATABASE_URL` is required; `.env` is gitignored.
if (!hasDatabase()) {

**dev / test — local `.env`:**

```bash
# .env (project root, gitignored)
DATABASE_URL=postgres://assaf@localhost/expense_dev   # include the local user
SESSION_SECRET=…         # signs the session cookie (random hex)
APP_EMAIL=…           # bootstrap: first account's email (empty DB only)
APP_PASSWORD=…           # bootstrap: first account's password (empty DB only)
# Receipts by email (all optional):
# INBOUND_EMAIL_ADDRESS=receipts@example.com   # forwarding + reply sender
# DEEPSEEK_API_KEY=sk-…          RECEIPT_OCR_MODE=auto
# FASTMAIL_TOKEN=…  PUSH_PRIVATE_KEY=…  PUSH_AUTH=…  CRON_SECRET=…  PUBLIC_URL=…
```

On an empty database the first account + user are bootstrapped from
`APP_EMAIL`/`APP_PASSWORD` (fail-closed if missing); thereafter, users are
created via the app's signup/join flow. `SESSION_SECRET` is always required.
`APP_EMAIL`/`APP_PASSWORD` can be omitted from `.env` after you have at least
one user.

Accounts created before email login (username era) retain their original
username as the stored email until `APP_EMAIL` is set — `initStore` then adds
that address to the bootstrap (oldest) user, so the configured credentials
continue to work.

Tests deliberately hardcode `expense_test` (Postgres with blobs/images), ignore
the local database, and reset the schema from Prisma on every run (`pnpm
test:db:push` in the test setup).

**prod — Vercel:** set env vars in the project dashboard (Settings →
Environment Variables): `DATABASE_URL` (Supabase Supavisor pooled URL),
`SESSION_SECRET`,
and (only until the first user exists) `APP_EMAIL` / `APP_PASSWORD`.
Vercel sets them during runtime; `.env` does not exist.

## Receipts by email

Forward an email receipt to your inbox address and it will be parsed and
imported automatically: the merchant, amount, and category are extracted, the
receipt is uploaded as an image, and the expense date is the date when the email
was forwarded. In case something could not be parsed, an explanation email is
sent back.

How it determines what to import:

- Receipt **attached as PDF/image** → the attachment is uploaded as the receipt
  image; text is extracted from the PDF text layer (or OCR'd) in order to parse
  the merchant/amount/category.
- Receipt **inline in the email** (ASCII/HTML) → the email body is converted to
  an image and uploaded; text is parsed similarly.
- Several attachments (for example, a receipt and some logo or signature) → only
  the actual receipt is processed (with heuristics + model tie-break).
- Sender email must be in the account's **allowed senders list** (Settings →
  Receipts by email); otherwise the email is replied with "sender not
  recognized".
- Successful imports trigger a response with all the parsed data; incomplete
  ones (missing merchant, amount, …) create the expense anyway and reply listing
  what's missing.
- Each email is processed at most once (idempotent on email id).

### Setup DeepSeek

- **DeepSeek vision**: the hosted DeepSeek API is text-only — receipt images are
  OCR'd locally with tesseract.js (worker/fonts fetched from a CDN at runtime).
  Set `RECEIPT_OCR_MODE=deepseek` if/when the hosted model will be able to
  handle receipt images (vision tries first and falls back on `auto`).
- **Scanned PDFs** (without the text layer) are rasterized and OCR'd; the first
  pages are uploaded as receipt image.
- **HTML receipts** are converted to a text image (receipt form on the paper) —
  no headless browser needed.
- Forwarding **as attachment (.eml)** — the receipt enclosed in `.eml` is not
  parsed; use normal inline forwarding (for example, Gmail/iOS includes original
  email in the body).
- Webhook processing time limit is 60 seconds (max Vercel `maxDuration`) —
  enough to download attachment + OCR + parse.

## Maps & geocoding

OpenStreetMap services (Nominatim geocoding, OSRM routing, OSM raster tiles
maps). Rate limited but good enough for personal use. If OSRM is not available,
distance calculation fallbacks to the straight line (marked "approx.").
