# Code style (agent reference)

Deep version of the style rules summarized in `AGENTS.md` — read when writing or reviewing code.

## Tooling

- Run `pnpm check` (or `vp check --fix`, which also runs on staged files) before committing.
- `vpr check` excludes `vite.config.ts` from tsgolint (recursion limits); tsc still type-checks it.
- oxfmt: double quotes, 2-space indent, 80-col, semicolons — never hand-wrap or hand-sort.
- oxlint: strict mode + type-aware linting (`typeAware: true`, `typeCheck: true`), `react-hooks/rules-of-hooks` + `exhaustive-deps`, `typescript/no-explicit-any`, `no-console` (only `.assert`/`.error`/`.info`/`.warn`), `unicorn/no-array-for-each` / `prefer-array-flat-map`, `react/no-danger`.

## TypeScript

- Prefer interfaces over types for object shapes; `type` for unions/aliases (`type Expense = ReceiptExpense | MileageExpense`).
- No enums — string unions (`type ExpenseType = "receipt" | "mileage"`).
- Avoid `any` — narrow with `unknown`.
- Descriptive names — auxiliary-verb booleans: `isComplete`, `hasAmount`.
- No classes — pure functions; only error subclasses (`class DeepSeekError extends Error`).
- Early returns — handle errors/guards at the top of functions.

## Imports & organization

- Path alias `~/*` → `app/*`; relative imports only for same-directory siblings (`./x`), never `../`.
- Group imports by origin: `node:` builtins → external packages → `~/*` → relative — `./+types/<name>` last where present.
- `import type` for type-only imports.
- No barrel files — import from the concrete module.
- File structure: exports at top, then module-level helpers/constants, then types (see `app/lib/db/accounts.ts`, `inbound-email.server.ts`).

## React & components

- Functional components only — no classes.
- Named exports for shared components (`export function Button`); route modules `export default` the page.
- Component naming: PascalCase; files in `app/components/` (`ui/` for primitives).
- No `dangerouslySetInnerHTML` — escape untrusted text with `escapeHtml` (`app/lib/escape.ts`).

## Accessibility

The a11y smoke tests (`test/a11y.test.ts`) enforce the contract — skip-link, page titles, keyboard shortcuts, focus trapping, `aria-invalid`, `aria-pressed`, `aria-expanded` — and the shared primitives already follow it. The rules:

- Icons carry `aria-hidden="true"` (standalone icon buttons get an `aria-label` on the `<button>`).
- Inputs set `aria-invalid={true}` when invalid (shared `Input`/`Textarea` do this automatically); pair error text with `aria-describedby`.
- Overlays trap focus on open, restore it on close, close on Escape (`ConfirmDialog`, `Lightbox` are the pattern).
- WCAG AA contrast: nothing below `text-gray-500` on white (placeholder, helper text, functional icons included).
- Touch targets ≥ 24×24 CSS px (small icon-only buttons need at least `p-1`).
- Every route exports a `meta` with a descriptive `<title>`; pages use `<main id="main-content">` + exactly one `<h1>`; sections get `<h2>`.
- Primary actions have keyboard shortcuts (editor: Enter saves, Escape cancels).
- Respect `prefers-reduced-motion` (guard any new animation/smooth scroll).
- Tests use accessible selectors (`getByRole`/`getByLabel`/`getByText`).

## Conditionals & logic

- Prefer early returns over nested if/else.
- No `forEach` — `for...of`, `.map()`, `.filter()`, `.flatMap()`.

## Error handling & validation

- Validate at the boundary — plain helper validators in `app/lib/validation.ts`, completeness rules in `app/lib/completeness.ts`.
- Handle errors first (guard clauses); return early on bad input.
- Catch at boundaries and log with `console.warn`/`console.error` (see Logging).

## Logging

- Allowed methods: `.assert`, `.error`, `.info`, `.warn` (no `console.log`).
- Prefix runtime logs with a context tag: `console.warn("[draft-upload] …")`.

## Security

- scrypt for password hashing (`app/lib/passwords.ts`); never store plaintext.
- Escape untrusted text before embedding in HTML/SVG/email (`escapeHtml`).
- Sanitize free-text filenames (`sanitizeFilenamePart`).
- Authenticated responses must not be shared-cacheable. Receipt images use `Cache-Control: private` — never flip to `public`. Every HTML document denies framing (`X-Frame-Options: DENY` + `CSP: frame-ancestors 'none'` in the root loader headers). HSTS comes from Vercel.
- Server-side fetches of untrusted URLs go through `fetchPublicUrl` (`app/lib/ssrf.server.ts`) — literal + DNS-resolved private-address checks, re-checked on every redirect hop. Never raw-fetch an attacker-controlled URL.

## Git commits

- Conventional commits, lowercase type, optional scope: `type(scope): subject` — e.g. `feat(analytics): …`. No emoji prefixes.
- Imperative mood, atomic commits, explain why not just what.
- Run `pnpm check` before committing.
