---
# The support page at /support, and its markdown mirror /support.md.

# Filled in at build time: {{siteUrl}} (the full list is in
# app/lib/content.server.ts).

# The body is the document: "## " starts a section, each paragraph is one line
# (a line break inside a paragraph starts a new one), and a line starting with
# "- " makes a bullet list. Inline **bold**, [links](https://…), and
# [mailto links](mailto:you@example.com) are supported.

metaTitle: |-
  Expense support: how to get help and who to write to
description: |-
  How to reach the person who builds Expense, what to put in a support message, the answers you can find without waiting, how to connect or disconnect a mailbox, and how to close your account.
eyebrow: "Support"
title: |-
  How to get help with Expense
summary: |-
  Expense is built and run by one person, so support email reaches him directly: {{supportEmail}}.
updated: "September 15, 2026"

mirror:
  title: "Support"
---

## Getting support

Expense is maintained by a single person, Assaf Arkin. Support requests are directed directly to him, without going through a helpdesk ticket system: [{{supportEmail}}](mailto:{{supportEmail}}). No ticket system, no chat window, and no phone tree need to be navigated prior to contacting him.

Describe your account's login email, what was being done when an issue occurred, and what the expectation was.

In case of an error with a particular expense, linking to that expense, including the date, merchant, and amount may be enough to avoid additional back and forth. A screenshot of the screen you're viewing is also very helpful.

## Questions that are currently answered

The [FAQ]({{siteUrl}}/faq) describes how the receipts are parsed, how mileage is priced, and how the application compares to similar applications. To learn how to connect an assistant and the tools it will have access to after the connection, visit the [MCP page]({{siteUrl}}/connect). The [privacy policy]({{siteUrl}}/privacy) provides information about what the app collects and who else might have access.

In case a forwarded receipt hasn't been received, the [Email page]({{siteUrl}}/emails) should be visited for more information, including the forwarding email address and the approved senders.

## Your account

Everything you can configure on your account can be changed in the [Settings]({{siteUrl}}/settings): password, sign-in email, connected mailboxes, authorized assistants, and account closure (deletion of your expenses and receipt images).

Account lockout is possible. In that case, the password reset option on the [sign-in page]({{siteUrl}}/login) can be used. In case of problems receiving the password reset email, email support with the email associated with your account.

## Mailboxes

To add a mailbox, visit the [Emails page]({{siteUrl}}/emails). To connect a Gmail account, you'll need to provide credentials using Google sign-in. To connect a Fastmail account, you'll need to do the same.

To disconnect a mailbox, visit the same page to revoke the token stored by the application. Access can also be revoked at the provider. To do that for Fastmail, visit Settings -> Privacy & Security -> Connected apps & API tokens -> Remove access. For Google, visit the third-party access page of your Google Account.

## Security reporting

If you find a way to access another user's expenses or data, please contact us at the above email address, and allow some time to address the problem. There's no bug bounty offered at this point – just a fix and a thank you.
