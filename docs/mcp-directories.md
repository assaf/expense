# Listing the MCP server in directories

Where to publish `https://expense.labnotes.org/mcp` so people (and their
clients) can find it. Start with the **Official MCP Registry**: it
auto-propagates to PulseMCP, VS Code / Copilot, and other aggregators.

## 1. Official MCP Registry (do this first)

`registry.modelcontextprotocol.io` is the centralized metadata registry
backed by Anthropic, GitHub, PulseMCP, and Microsoft. It's in **preview**;
expect possible breaking changes. Publishing is done with the
`mcp-publisher` CLI; the metadata lives in `server.json` at the repo root
(already written: `name: io.github.assaf/expense`, a remote Streamable HTTP
server at `/mcp`, no package).

```bash
# Install the CLI (macOS/Linux)
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
# or: brew install mcp-publisher

cd <repo>
mcp-publisher login github     # device-code flow; GitHub username "assaf" must
                               # match the io.github.assaf/ namespace
mcp-publisher publish          # pushes server.json to the registry
```

Verify:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=expense"
```

Notes:

- **Namespace**: with GitHub auth the name must start with
  `io.github.<username>/`. You own `labnotes.org`, so DNS authentication
  would let you use `com.labnotes/expense` (or similar) instead; see
  https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/authentication.mdx.
- **Bump `server.json` version** on meaningful changes and re-run `publish`
  (the update endpoint is not implemented yet, so treat each publish as a new
  version).
- Automate with GitHub Actions:
  https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/github-actions.mdx

## 2. Glama (glama.ai)

Glama auto-indexes GitHub servers; `glama.json` at the repo root (already
written, `maintainers: ["assaf"]`) claims ownership of the listing so you
can edit the name/description, see usage reports, and get review
notifications.

1. Make sure the repo has the **`mcp-server` GitHub topic** (repo → Settings
   → Topics); Glama indexes from topics.
2. After any `glama.json` change, re-run the **Claim** flow on the server's
   Glama page to resync.
3. Since the repo is under your personal account, authenticating with GitHub
   also associates the listing automatically.

## 3. Smithery (smithery.ai)

Bring-your-own-hosting registry: Smithery's gateway proxies to your server.
Submission is a form at https://smithery.ai/new with the public HTTPS URL
`https://expense.labnotes.org/mcp`. Requirements we already meet:
**Streamable HTTP transport** and **OAuth support** (no client registration
needed server-side).

## 4. PulseMCP (pulsemcp.com)

Manual submission form at https://pulsemcp.com/submit (GitHub repo +
documentation + protocol compliance). PulseMCP also ingests from the
Official MCP Registry (~1 week propagation); publishing there first may make
this automatic.

## 5. mcp.so

Community marketplace. Manual submission via the form at https://mcp.so/submit
or a GitHub issue (Cloudflare blocks automated submissions; do it by hand).

## 6. Claude plugin directory (Claude Desktop)

Keep an eye on Anthropic's plugin/marketplace directory for MCP servers.
`server.json` in the registry format is the metadata they consume, so
publishing to the Official Registry is the prerequisite.

## What to say in each listing

- **Short description**: "Expense — capture receipts, log mileage, answer
  spending questions, build reports, and reconcile statements from your AI
  assistant. OAuth sign-in, no API keys."
- **Tags**: expenses, receipts, mileage, tax, bookkeeping, accounting,
  finance, reconciliation
- **Link to**: https://expense.labnotes.org/ai (the marketing page) and
  https://expense.labnotes.org (signup)
