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

**Any day** — MCP directories: paste `mcp-directory.md` into PulseMCP and mcp.so submit forms. Glama auto-indexes, no action needed.

**Ongoing** — Personal network: DM 10-20 freelancer/self-employed contacts individually, one line each ("I built this, free until 100 users, thought of you"). Highest conversion per message of anything on this list.

## Week 2 (Sep 7 – 13): bigger beats, only if week 1 converted

**Mon 9/7** — Publish `introducing-expense.md` on Medium (and/or LinkedIn as an article). Canonical note pointing back to expense.labnotes.org.

**Tue 9/8** — Scheduled feature blog post goes out (command palette).

**Mid-week** — AlternativeTo listing: create the entry with the copy from `alternativeto.md`, list it as an alternative to Expensify and Shoeboxed. Low effort, long tail.

**Thu 9/10 or hold** — Product Hunt. Only if the landing page converted well so far (see measurement); PH punishes a weak page. Otherwise slide to week 3 and keep the listing warm.

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
