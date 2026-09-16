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

## What the app stores

Your account: the email address you signed up with, a password hash (never the password itself), and the account's invite code.

What you put in: receipts and their images, the merchant, amount, date, category, report, and any notes; mileage trips with their stops, addresses, and route; and the questions and answers in the Insights chat.

An account is shared with everyone you invite: members see the same expenses, so invite deliberately.

## Email

If you forward receipts by email, the app reads those messages and keeps a log of what it did with each one, so the same message is never imported twice.

If you connect Gmail or Fastmail, the app stores that mailbox's OAuth tokens encrypted, reads the mail it needs to find receipts, and stops reading when you disconnect.

## Where it lives

Vercel runs the app and Supabase Postgres (US West) holds the data, receipt images included. There is no separate file store and no copy in your browser.

## Who else sees it

The model provider: receipt images and your questions are sent to the LLM this deployment is configured with (DeepSeek's API by default) to be read and answered. Every figure on Insights is computed by the app from your own expenses; the model only phrases it, so it cannot invent a number.

Google or Fastmail for the mailbox you choose to connect, and nobody else.

Frankfurter, which publishes the ECB reference rates, for currency conversion; it is asked for a currency and a date, never for your data.

OpenStreetMap's Nominatim and OSRM for looking up addresses and measuring driving routes.

Sentry receives error reports (the URL has its query string stripped first, so emailed tokens are not part of them) and Umami counts visits, tagging signed-in ones with your account id. Neither runs ads or follows you to other sites.

## What it never does

No selling or sharing your data, no ad networks, no cross-site trackers, and no bank connections: a statement is a file you upload, not an account you hand over.

An assistant you connect over MCP can read and write your expenses while it is connected, reaches only your own account, and stops the moment you revoke it in Settings.

## Cookies

One session cookie that keeps you signed in, and your theme preference in local storage. Nothing else is stored in the browser.

## Your controls

Change your password or your sign-in email in Settings: a password change signs out your other devices, an email change notifies the old address. Delete any expense or report, disconnect a mailbox (which deletes its stored tokens), or revoke an assistant's access, all in the app.

Close your account in Settings whenever you like: your expenses, receipt images, reports, trips and connected mailboxes are deleted straight away, and the account itself goes with them when you are its last member. If other people are still on the account, only your login leaves.

## Changes

When this policy changes, the date above changes with it. Questions go to assaf@labnotes.org.
