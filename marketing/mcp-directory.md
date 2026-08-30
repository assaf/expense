# MCP directory listing copy (PulseMCP, mcp.so, Glama)

## Name

Expense

## One-liner

Personal expense tracker with an MCP server: log mileage, file receipts, and query your spending from any MCP client.

## Description

Expense (https://expense.labnotes.org) is a hosted expense tracker for freelancers and the self-employed, exposed to AI assistants over MCP at https://expense.labnotes.org/mcp (OAuth 2.1).

Connect Claude Desktop, Claude Code, or any MCP client to your own account and work your books in plain English:

- log_mileage: "log the drive to the client office on Tuesday"; routes and IRS-rate amounts are computed for you.
- capture_receipt: send receipt images; OCR and a language model extract merchant, amount, date, and Schedule C category.
- list_expenses and reports: "how much did I spend on software this quarter", filtered by date, category, merchant, or description.
- reconcile: match a bank statement's charges against logged expenses to surface forgotten deductions.

The server is the same one the web app uses, so anything logged through the assistant lands in the same account, organized by IRS Schedule C lines, with duplicate detection and ECB-rate currency conversion handled automatically.

Hosting: managed (hosted), auth: OAuth 2.1. Free while the service is under 100 users; no credit card to sign up.

## Setup

1. Create an account at https://expense.labnotes.org.
2. Open Settings, then Agents & API, and add an MCP client; the app walks you through OAuth.
3. Point your client at https://expense.labnotes.org/mcp.
