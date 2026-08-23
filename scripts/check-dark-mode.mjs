#!/usr/bin/env node
/**
 * Dark-mode variant check (docs/dark-mode.md): every color utility class in
 * a className string must have a `dark:` twin of the same utility family
 * (bg→bg, text→text, border→border, …) whose variant set covers it, e.g.
 * `hover:bg-gray-100` is satisfied by `dark:hover:bg-gray-800` (exact) or
 * by `dark:bg-gray-800` (dark base covers the hover state — Tailwind emits
 * dark: after interactive variants, so it wins on hover). Catches:
 *
 *   - a color class with no dark variant at all (unreadable in dark mode)
 *   - conflicting `dark:` values for one utility+variant set, e.g.
 *     `text-gray-700 dark:text-gray-700 dark:text-gray-200` (the second
 *     silently wins — the typo class this check exists for)
 *
 * Theme-neutral utilities are exempt (they resolve identically in both
 * themes): transparent/current/inherit, `--color-ink`, white/black text on
 * colored surfaces, opacity overlays (bg-white/50, bg-black/50), the dark-
 * side muted text shades (gray-50…400), status-dot colors (hue-400
 * backgrounds), and status icon text (amber/green-600). The exact light→dark
 * color mapping is guidance in docs/dark-mode.md, not enforced here — the
 * app's surfaces legitimately use /50 opacities and tinted darks.
 *
 * Runs on every `.tsx` under `app` (components + routes).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const APP_DIR = process.env.APP_DIR ?? "app";

/** A color utility token: variant prefixes + family + color, with optional
 * opacity and shade. */
const COLOR_UTILITY =
  /^(?:(?:[a-z]+:)*)(bg|text|border|ring|placeholder|divide|outline|shadow|ring-offset)-(white|black|gray|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:\/\d+)?(?:-(?:50|100|200|300|400|500|600|700|800|900|950))?$/;

/** Theme-neutral: same value in both themes. */
const NEUTRAL = /-(?:transparent|current|inherit)$/;
/** `--color-ink` resolves per theme — never needs a dark twin (docs). */
const INK = /-(?:bg|text)-ink$/;
/** Dark-side muted text — valid on both themes (docs map gray-500/600/700/800
 * TO these, so they are the dark-mode text palette). */
const DARK_SIDE_TEXT = /^text-gray-(?:50|100|200|300|400)$/;
/** Status indicator dots — the same color in both themes by design. */
const STATUS_DOT =
  /^bg-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-400$/;
/** Status icon text on tinted badges — readable on both themes. */
const STATUS_ICON_TEXT = /^text-(?:amber|green|red|teal)-(?:500|600|700)$/;
/** White/black text on colored buttons — theme-neutral. */
const SURFACE_TEXT = /^text-(?:white|black)$/;
/** Opacity overlays (scrims, hero glows) — theme-neutral. */
const OVERLAY = /^(?:bg|text)-(?:white|black)\/\d+$/;
/** Dark-side surfaces — the dark-mode palette itself, safe to use as
 * always-dark tiles (e.g. a logo tile) in both themes. */
const DARK_SIDE_BG = /^bg-gray-(?:800|900|950)$/;
/** Deep accent fills paired with white text (badges, progress, verification
 * icons) — the fill color reads on both themes. */
const DEEP_ACCENT_BG =
  /^bg-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:500|600|700|800)$/;

function isExempt(token) {
  return (
    NEUTRAL.test(token) ||
    INK.test(token) ||
    DARK_SIDE_TEXT.test(token) ||
    STATUS_DOT.test(token) ||
    STATUS_ICON_TEXT.test(token) ||
    SURFACE_TEXT.test(token) ||
    OVERLAY.test(token) ||
    DARK_SIDE_BG.test(token) ||
    DEEP_ACCENT_BG.test(token)
  );
}

/** All variant prefixes of a token, e.g. `dark:hover:bg-gray-800` → Set{dark, hover}. */
function variants(token) {
  const at = token.lastIndexOf(":");
  if (at === -1) return new Set();
  return new Set(token.slice(0, at).split(":"));
}

/** The bare utility without any variant prefixes. */
function bare(token) {
  return token.slice(token.lastIndexOf(":") + 1);
}

function* tsxFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* tsxFiles(full);
    else if (entry.name.endsWith(".tsx")) yield full;
  }
}

/** Extract className string literals (single/double quotes and template
 * literals without `${}` interpolation). */
function classNames(src) {
  const out = [];
  const re = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)/g;
  for (const m of src.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const problems = [];

for (const file of tsxFiles(APP_DIR)) {
  const src = readFileSync(file, "utf8");
  for (const cls of classNames(src)) {
    if (!cls.trim()) continue;
    const tokens = cls.split(/\s+/).filter(Boolean);
    const darks = tokens.filter((t) => t.startsWith("dark:"));

    // Conflicting dark values for one utility + variant set.
    const byKey = new Map();
    for (const d of darks) {
      const b = bare(d);
      const parts = b.split("-");
      // bg-gray-800/50 → key bg-gray (opacity and shade are values, not keys)
      const key = `${[...variants(d)].sort((a, b) => a.localeCompare(b)).join("+")}:${parts[0]}-${parts[1]}`;
      const existing = byKey.get(key);
      if (existing && existing !== d) {
        problems.push(
          `${file}: \`${cls}\` has conflicting dark variants \`${existing}\` and \`${d}\``,
        );
      } else {
        byKey.set(key, d);
      }
    }

    // Every non-exempt color utility needs a dark twin of the same family
    // whose variant set covers it. Coverage: the dark twin's variants minus
    // `dark` are a SUBSET of the light token's variants — e.g. `dark:text-red-400`
    // covers `hover:text-red-600` because Tailwind emits dark: after hover:,
    // so the dark base wins on hover. The one exception: `file:` targets the
    // `::file-selector-button` pseudo-element, which a plain dark: utility
    // never styles — those need an explicit `dark:file:` twin.
    for (const token of tokens) {
      if (token.startsWith("dark:")) continue;
      if (isExempt(token)) continue;
      const m = COLOR_UTILITY.exec(token);
      if (!m) continue;
      const family = m[1];
      const v = variants(token);
      const covered = darks.some((d) => {
        if (!d.startsWith("dark:")) return false;
        const dv = variants(d);
        if (!dv.has("dark")) return false;
        if (v.has("file") && !dv.has("file")) return false;
        const dvMinusDark = new Set([...dv].filter((x) => x !== "dark"));
        for (const x of dvMinusDark) if (!v.has(x)) return false;
        return bare(d).startsWith(`${family}-`);
      });
      if (!covered) {
        problems.push(
          `${file}: \`${cls}\` has \`${token}\` without a dark: twin (expected \`dark:${[...v].join(":")}:${bare(token)}\`)`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`Dark-mode check failed — ${problems.length} issue(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
process.stdout.write("pass: every color class has its dark: variant\n");
