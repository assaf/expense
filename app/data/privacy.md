---
# The privacy policy at /privacy, and its markdown mirror /privacy.md.

# Filled in at build time: {{siteUrl}}, {{mcpEndpoint}}, {{mileage}},
# {{mileagePeriod}}, {{mileageFirstYear}}, {{mileageLastYear}}, {{categoryCount}}. See
# app/lib/content.server.ts.

# The body is the document: "## " starts a section, and each paragraph is one
# line (a line break inside a paragraph starts a new one). Inline **bold**,
# [links](https://…), and [mailto links](mailto:you@example.com) are supported.

metaTitle: |-
  Privacy policy
description: |-
  What Expense stores, where it lives, which providers see what, and what it never does.
eyebrow: "Privacy"
title: |-
  What Expense does with your data
summary: |-
  Expense is a personal expense tracker run by one person. It keeps what you put into it, sends receipts to a model to be read, and gives nothing to anyone else.
updated: "September 14, 2026"

mirror:
  title: "Privacy"
---

## Your personal information

- Your account: your sign-up email address, hashed password (not your actual password) and account invite code.
- What you enter: receipts and their image, merchant, amount, date, category, report and notes; mileage trips with stops, addresses, and route; and the Q&A from Insights chat.
- The account is shared with everybody you invite: they all see the same expenses, so invite with care.

## Email

- If you forward receipts by email, the app parses the emails and maintains a log of how it processed each one, to avoid importing a receipt more than once.
- If you connect Gmail or Fastmail, the app stores encrypted OAuth tokens of that mailbox, reads relevant emails to find receipts and stops when you disconnect.

## Storage locations

- Vercel hosts the app, and Supabase Postgres (US West region) contains the data, including receipt images.

## People who can see it

- The model provider: receipt images and your questions are sent to the LLM that this solution uses to parse and answer. Every number in Insights is computed by the app using your expenses; the model provides the wording and cannot make up numbers.
- Google/Fastmail for the mailbox you connect, and nobody else.
- Frankfurter, publisher of ECB reference rates for currency conversion; it needs the currency and a date of transaction, nothing else.
- OpenStreetMap’s Nominatim and OSRM for geocoding addresses and routing.
- Sentry receives error reports (it strips the query string from the URL, so the emailed token is not included) and Umami analytics, signing in sessions are tagged by your account id. Neither shows you ads or follows you to other sites.

## It never

- sells, shares or otherwise exposes your data, uses any ad network, cross-site tracker, or connects with your banking accounts. A statement is a file you upload, not an account you give.
- connects an assistant over the MCP protocol and allows it to read and write your expenses while it is connected to your account; the assistant only sees your account, and stops as soon as you revoke it in Settings.

## Cookies

- One session cookie to keep you signed in, and your theme preference in the local storage. Nothing else is stored locally.

## Your controls

Change your password or sign-in email in Settings. Password change logs you out of other devices, email change sends notification to your old email. Delete any expense or report, disconnect a mailbox (this also deletes its stored tokens), or revoke assistant access – all in the app.

Delete your account in Settings anytime: your expenses, receipt images, reports, trips, and connected mailboxes are immediately deleted, and the account disappears when you are the last member. If there are other members on the account, your login is just deleted.

## Changes

This privacy policy may change at any time. The date below will be updated whenever it happens. If you have any questions, please contact [assaf@labnotes.org](mailto:assaf@labnotes.org).
