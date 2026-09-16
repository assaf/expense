---
# The support page at /support, and its markdown mirror /support.md.

# Filled in at build time: {{siteUrl}} (the full list is in
# app/lib/content.server.ts).

# The body is the document: "## " starts a section, and each paragraph is one
# line (a line break inside a paragraph starts a new one). Inline **bold** and
# [links](https://…) are supported.

metaTitle: |-
  Expense support: how to get help and who to write to
description: |-
  How to reach the person who builds Expense, what to put in a support message, the answers you can find without waiting, how to connect or disconnect a mailbox, and how to close your account.
eyebrow: "Support"
title: |-
  How to get help with Expense
summary: |-
  Expense is built and run by one person, so support email reaches him directly: assaf@labnotes.org.
updated: "September 15, 2026"

mirror:
  title: "Support"
---

## How to reach support

Expense is built and maintained by one person, Assaf Arkin, and support goes straight to him rather than into a queue: [assaf@labnotes.org](mailto:assaf@labnotes.org). There is no ticket system, no chat window, and no phone tree to get through first.

Say which email address your account signs in with, what you were doing when something went wrong, and what you expected instead. If it is about one expense, a link to it, or its date, merchant, and amount, saves a round trip, and a screenshot of the screen helps.

Replies come from Los Angeles, usually within a couple of days.

## Answers you can find right now

The [FAQ]({{siteUrl}}/faq) covers how receipts are read, how mileage is priced, and how Expense compares to other apps. Connecting an assistant, and the tools it gets once it's in, is on the [MCP page]({{siteUrl}}/connect). What the app stores and who else sees it is the [privacy policy]({{siteUrl}}/privacy).

If a forwarded receipt never arrived, open the [Email page]({{siteUrl}}/emails). It shows the address to forward to and which senders are allowed to use it.

## Your account

Everything you can change about your account lives in [Settings]({{siteUrl}}/settings): your password, your sign-in email, the mailboxes you connected, the assistants you authorized, and closing the account, which deletes your expenses and receipt images.

Locked out? Use the password reset on the [sign-in page]({{siteUrl}}/login). If the reset email never shows up, write to support and name the address the account uses.

## Mailboxes

Connect a mailbox on the [Email page]({{siteUrl}}/emails). Gmail connects with a Google sign-in. Fastmail connects the same way.

Disconnect a mailbox on the same page, and that deletes the token the app stored. Access can also be cut off at the provider: in Fastmail, Settings -> Privacy & Security -> Connected apps & API tokens, then Remove access, and in Google, the third-party access page of your Google Account.

## Reporting a security problem

If you find a way to reach another account's expenses or data, email the address above and give it time to get fixed before writing about it in public. There is no bug bounty here, just a fix and a thank you.
