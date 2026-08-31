# Launch plan: 10+ users in two weeks

_Saved 2026-08-30. Everything referenced here exists in this directory plus the blog queue. The app bits (spot counter, ref attribution, Umami signup event) are already live on production._

## Assets inventory

| Asset                               | Where                              | Status                                           |
| ----------------------------------- | ---------------------------------- | ------------------------------------------------ |
| Long-form product article           | `marketing/introducing-expense.md` | Ready to paste                                   |
| Show HN title + text                | `marketing/show-hn.md`             | Ready                                            |
| Indie Hackers page + launch post    | `marketing/indie-hackers.md`       | Ready                                            |
| r/SideProject post                  | `marketing/reddit-sideproject.md`  | Ready                                            |
| AlternativeTo listing               | `marketing/alternativeto.md`       | Ready                                            |
| MCP directory listing               | `marketing/mcp-directory.md`       | Ready                                            |
| Blog launch post (yours to publish) | `blog/2026-09-01-100-users.md`     | Queued for Tue 9/1                               |
| Feature blog posts                  | `blog/2026-09-*.md` onward         | Queued weekly                                    |
| MCP registry metadata               | `server.json`                      | Committed; needs `mcp-publisher` login + publish |

## Week 1 (Aug 31 – Sep 6): warm and niche

**Tue 9/1** — Publish the labnotes post (yours). It's the anchor; every later link can reference it.

**Tue 9/1** — MCP registry: run `npx mcp-publisher login` (GitHub device flow, you approve in the browser), then `npx mcp-publisher publish`. Ten minutes, one-time.

**Wed 9/2** — Indie Hackers: create/claim the product page with the tagline and description, then post the launch post. IH rewards replies, so plan to answer comments that evening.

**Wed 9/2 or Thu 9/3, 8–10am ET** — Show HN. Post Tue–Thu morning, never Friday. Submit the title + text from `show-hn.md`, then stay near the thread for two hours; the first hour decides whether it climbs. If it gains traction, hold Reddit for a few days so the traffic doesn't split.

**Fri 9/4** — r/SideProject post (skip if Show HN went well; reschedule to Mon 9/7). Rules: it's a text post, link in the body, answer every comment.

**Any day** — MCP directories: after the registry publish, PulseMCP and Smithery ingest from it automatically (about a week; hello@pulsemcp.com can speed it up). mcp.so takes a GitHub-issue submission, and Glama auto-indexes with no action needed.

**Ongoing** — Personal network: DM 10-20 freelancer/self-employed contacts individually, one line each ("I built this, free until 100 users, thought of you"). Highest conversion per message of anything on this list.

## Week 2 (Sep 7 – 13): bigger beats, only if week 1 converted

**Mon 9/7** — Publish `introducing-expense.md` on Medium (and/or LinkedIn as an article). Canonical note pointing back to expense.labnotes.org.

**Tue 9/8** — Scheduled feature blog post goes out (command palette).

**Mid-week** — AlternativeTo listing: create the entry with the copy from `alternativeto.md`, list it as an alternative to Expensify and Shoeboxed. Low effort, long tail.

**Thu 9/10 or hold** — Product Hunt. Only if the landing page converted well so far (see measurement); PH punishes a weak page. Otherwise slide to week 3 and keep the listing warm.

## AI visibility submissions

A second track alongside the launch channels: get Expense named on the sites AI answers pull from. Third-party mentions carry far more citation weight than the product's own site (a widely cited figure is 6.5x), so these listings do more for AI visibility than on-page copy.

### Tier 1: direct AI-citation impact

| Site                                            | What to submit                                                                 | Notes                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| MCP Registry (registry.modelcontextprotocol.io) | `npx mcp-publisher login`, then `npx mcp-publisher publish` with `server.json` | Already scheduled Tue 9/1. The canonical source: PulseMCP and Smithery ingest from it automatically, so one publish covers them |
| Bing Webmaster Tools + IndexNow                 | Verify the domain, submit the sitemap, enable IndexNow                         | The biggest gap in this plan: ChatGPT search runs on Bing's index and Copilot is Bing-only. One-time setup, about an hour       |
| G2                                              | Free vendor listing; adapt the full description in `alternativeto.md`          | What AI cites for "best expense tracker" queries. The listing counts even before reviews accumulate                             |
| Capterra                                        | Free listing, same description                                                 | Same Gartner family as GetApp and Software Advice, so one entry can propagate to siblings                                       |

### Tier 2: unique niche and strong directories

| Site                                                 | What to submit                                                                | Notes                                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FastMail partnership (partnerships@fastmailteam.com) | Short pitch email: OAuth receipt auto-import, offer a "built on JMAP" writeup | No public directory exists; Fastmail blogs customer integrations (Morgen, Secret Inbox precedent). Owns the zero-competition "FastMail receipt tracking" query class. The OAuth client is already in the codebase, env-gated. Pitch email still to draft |
| Smithery (smithery.ai)                               | Nothing unless it has not appeared about 2 weeks after the registry publish   | Ingests from the registry on its own schedule (3-14 days)                                                                                                                                                                                                |
| mcp.so                                               | GitHub-issue submission via their Submit button                               | Paste the copy from `mcp-directory.md`                                                                                                                                                                                                                   |
| There's An AI For That (theresanaiforthat.com)       | Free submission, AI tools category                                            | The MCP server is the qualifying angle                                                                                                                                                                                                                   |
| SaaSHub and OpenAlternative                          | Free listings, open-source alternative angle                                  | The pages AI quotes for "open-source Expensify alternative"                                                                                                                                                                                              |

### Tier 3: cheap, when convenient

| Site                                            | What to submit                                                                         | Notes                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| llms.txt directories (llmstxt.site and friends) | Submit the existing `/llms.txt`                                                        | Marginal, but the file is already written                                              |
| DevHunt, Uneed, MicroLaunch                     | Launch posts                                                                           | Indie boards with modest crawl weight; use one only if a launch slot is free that week |
| Quora                                           | Answers to existing "Expensify alternative for freelancers" questions                  | Long-tail queries ChatGPT draws on; answer, don't pitch                                |
| Reddit beyond r/SideProject                     | Replies in r/freelance, r/smallbusiness, r/Bookkeeping threads asking for alternatives | Rules of engagement apply: relevant replies only, never cross-post                     |

One confirmation: check Google Search Console has the sitemap. AI Overviews run on Google's index; likely already set up, but a one-minute check.

## Measurement

- Umami dashboard: visits and the `signup` event, split by page.
- `ref` attribution: blog links carry `?ref=labnotes.org`; add a distinct `ref` per channel when posting (e.g. `?ref=show-hn`, `?ref=indie-hackers`) so the account rows tell you which channel signed up, not just clicked.
- Check accounts created per day: the counter on the landing page is the public scoreboard, the DB is the private one.
- Target arithmetic: at a 1.5–3% visit-to-signup rate, 10 users needs 300–700 targeted visits. Show HN on a good day alone clears that; personal network plus directories usually add the rest.

## Rules of engagement

- One channel per day maximum; reply to every comment on the day it's posted.
- Reddit and HN: mention the MCP server and stack only when asked or when it's genuinely the point; those audiences punish marketing cadence.
- If any channel takes off, pause the calendar and work that channel instead.
- Never post the same text to two venues; each file is venue-specific on purpose.

## Standing invitations for future sessions

- "Publish the next blog post" — queue head is `blog/2026-09-08-command-palette.md`, Tuesdays.
- "Check the launch numbers" — I can query Umami and the accounts table and tell you which channel is converting.
- Enable the omp Browser Relay extension and I can post the copy to your logged-in venues directly, one at a time for your approval.
