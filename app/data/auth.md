# auth.md

How an agent gets access to an Expense account, and how that access ends.
This document is written for the program, not for the person it works for.

## Who this is for

Agents and assistants that want to call the MCP endpoint at
{{mcpEndpoint}} on behalf of a signed-in user. Expense is a personal
expense tracker: capture receipts, log mileage at the IRS rate, reconcile a
bank statement, export a report.

## What access looks like

There is no API key, and an agent cannot create an account for itself.
Every connection is a person signing in and approving the agent, which
returns OAuth 2.1 tokens. One token reaches exactly one account. A second
person's token never sees the first person's expenses.

## Discovery

Everything an agent needs is published before it connects:

- `{{siteUrl}}/.well-known/oauth-protected-resource/mcp` is the protected
  resource metadata for the endpoint (RFC 9728): the resource identifier and
  the authorization server that issues tokens for it.
- `{{siteUrl}}/.well-known/oauth-authorization-server` is the authorization
  server metadata (RFC 8414), mirrored at
  `{{siteUrl}}/.well-known/openid-configuration` for clients that look there.
- `{{mcpEndpoint}}/server-card` is the server card: identity, transport, and
  the protocol revisions the endpoint speaks.
- A request to `{{mcpEndpoint}}` without a token answers `401` with
  `WWW-Authenticate: Bearer resource_metadata="…"` pointing at the first
  document above.

## Registration

Clients register themselves at `{{siteUrl}}/oauth/register` (RFC 7591
dynamic client registration). Registration returns a public client id and
needs no credentials of its own: the flow is PKCE, so there is no client
secret to leak. Registered clients are per-account rows, so a client
registered against one account is not visible to another. A client id
created out of band works too, without calling the endpoint.

One caveat in the current MCP specification: dynamic client registration is
deprecated in favor of Client ID Metadata Documents, which this server does
not implement. Its metadata does not advertise
`client_id_metadata_document_supported`, and a URL-shaped `client_id` is
rejected as an unknown client. Register here instead, or use a client id
issued out of band.

## Supported methods

| Method                             | Where                                                    | Notes                                                                                   |
| ---------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `authorization_code` + PKCE `S256` | `{{siteUrl}}/oauth/authorize`, `{{siteUrl}}/oauth/token` | Public client (`none`) or `client_secret_basic`. The user approves on the consent page. |
| `refresh_token`                    | `{{siteUrl}}/oauth/token`                                | Rotates on every grant.                                                                 |
| Revocation                         | `{{siteUrl}}/oauth/revoke`                               | RFC 7009. Revoking an access token does not kill its refresh token.                     |

Not offered: `client_credentials`, password grants, on-behalf-of tokens, and
signed identity assertions. There is nothing here an agent can do
unattended, and no way to widen a grant later without the user approving
again.

## Credentials

- Access tokens are opaque strings prefixed `oat_`, valid for one hour, and
  sent as `Authorization: Bearer <token>`.
- Refresh tokens are prefixed `ort_` and valid for 30 days. Store them where
  a user can revoke them.
- Only SHA-256 hashes are stored server-side; no plaintext token survives the
  request that issued it.

## Scopes

There are none to choose. An approval covers the whole account, writes
included, so treat it as full access and ask the user before a call that
changes data.

## How access ends

- The user disconnects the agent in **Settings → Agents & API (MCP)**, which
  revokes its tokens at once.
- A password reset revokes that user's access and refresh tokens.
- Every request carries its own token, and there are no sessions to outlive
  a revocation: the next call answers `401`.
