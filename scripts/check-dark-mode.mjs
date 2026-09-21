#!/usr/bin/env node
/**
 * Dark-mode variant check (docs/dark-mode.md): every color utility class in
 * a className string must have a `dark:` twin of the same utility family
 * (bg→bg, text→text, border→border, …) whose variant set covers it, e.g.
 * `hover:bg-gray-100` is satisfied by `dark:hover:bg-gray-800` (exact) or
 * by `dark:bg-gray-800` (dark base covers the hover state: Tailwind emits
 * dark: after interactive variants, so it wins on hover). Catches:
 *
 *   - a color class with no dark variant at all (unreadable in dark mode)
 *   - conflicting `dark:` values for one utility+variant set, e.g.
 *     `text-gray-700 dark:text-gray-700 dark:text-gray-200` (the second
 *     silently wins, the typo class this check exists for)
 *
 * Theme-neutral utilities are exempt (they resolve identically in both
 * themes): transparent/current/inherit, `--color-ink`, white/black text on
 * colored surfaces, opacity overlays (bg-white/50, bg-black/50), the dark-
 * side muted text shades (gray-50…400), status-dot colors (hue-400
 * backgrounds), and status icon text (amber/green-600). The exact light→dark
 * color mapping is guidance in docs/dark-mode.md, not enforced here, since the
 * app's surfaces legitimately use /50 opacities and tinted darks.
 *
 * Runs on every `.tsx` under `app` (components + routes).
 */
import { globSync, readFileSync } from "node:fs";

const APP_DIR = process.env.APP_DIR ?? "app";

/** A color utility token: variant prefixes + family + color, with optional
 * opacity and shade. */
const COLOR_UTILITY =
  /^(?:(?:[a-z]+:)*)(bg|text|border|ring|placeholder|divide|outline|shadow|ring-offset)-(white|black|gray|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:\/\d+)?(?:-(?:50|100|200|300|400|500|600|700|800|900|950))?$/;

/** Theme-neutral: same value in both themes. */
const NEUTRAL = /-(?:transparent|current|inherit)$/;
/** `--color-ink` resolves per theme and never needs a dark twin (docs). */
const INK = /-(?:bg|text)-ink$/;
/** Dark-side muted text, valid on both themes (docs map gray-500/600/700/800
 * TO these, so they are the dark-mode text palette). */
const DARK_SIDE_TEXT = /^text-gray-(?:50|100|200|300|400)$/;
/** Status indicator dots: the same color in both themes by design. */
const STATUS_DOT =
  /^bg-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-400$/;
/** Status icon text on tinted badges is readable on both themes. */
const STATUS_ICON_TEXT = /^text-(?:amber|green|red|teal)-(?:500|600|700)$/;
/** White/black text on colored buttons is theme-neutral. */
const SURFACE_TEXT = /^text-(?:white|black)$/;
/** Opacity overlays (scrims, hero glows) are theme-neutral. */
const OVERLAY = /^(?:bg|text)-(?:white|black)\/\d+$/;
/** Dark-side surfaces: the dark-mode palette itself, safe to use as
 * always-dark tiles (e.g. a logo tile) in both themes. */
const DARK_SIDE_BG = /^bg-gray-(?:800|900|950)$/;
/** Deep accent fills paired with white text (badges, progress, verification
 * icons); the fill color reads on both themes. */
const DEEP_ACCENT_BG =
  /^bg-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:500|600|700|800)$/;

/** Theme-neutral tokens, judged WITHOUT variant stripping: `hover:bg-white/10`
 * is a translucent overlay on both themes, and white/black text on a colored
 * button is too. Everything else is judged on the full token, so a variant
 * form still needs its own dark twin (`hover:text-red-600` is not covered by
 * the status-icon exemption of `text-red-600`). */
const ALWAYS_NEUTRAL = [NEUTRAL, OVERLAY, SURFACE_TEXT];
/** Tokens that are dark-side or accent colors by design: exempt only as the
 * whole utility, never as a variant of one. */
const CONTEXT_EXEMPT = [
  INK,
  DARK_SIDE_TEXT,
  STATUS_DOT,
  STATUS_ICON_TEXT,
  DARK_SIDE_BG,
  DEEP_ACCENT_BG,
];

function isExempt(token) {
  // Neutral ones compare the bare utility (an overlay stays neutral under any
  // variant); the dark-side/accent ones must match the whole token, so a
  // variant form of an exempt color still needs its own dark twin.
  if (ALWAYS_NEUTRAL.some((re) => re.test(bare(token)))) return true;
  return CONTEXT_EXEMPT.some((re) => re.test(token));
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

/** className values as GROUPS: one array of class-list strings per attribute.
 * A quoted attribute is one literal; a `{ … }` expression is its plain
 * literals, which compose at runtime. The quoted-only version this replaced
 * skipped every expression, which is how a copied `dark:text-red-400`
 * survived in a `cn()` call while the same text in a plain attribute was
 * caught. */
function classGroups(src) {
  const out = [];
  for (const m of src.matchAll(/className\s*=\s*/g)) {
    let i = m.index + m[0].length;
    const first = src[i];
    if (first === '"' || first === "'" || first === "`") {
      const close = src.indexOf(first, i + 1);
      if (close === -1) continue;
      out.push([src.slice(i + 1, close)]);
      continue;
    }
    if (first !== "{") continue;
    // Walk the balanced expression, then take its plain string literals.
    let depth = 0;
    let end = -1;
    for (let j = i; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) continue;
    const expr = src.slice(i + 1, end);
    const parts = [];
    for (const lit of expr.matchAll(/"([^"$]*)"|'([^'$]*)'|`([^`$]*)`/g)) {
      parts.push(lit[1] ?? lit[2] ?? lit[3]);
    }
    if (parts.length > 0) out.push(parts);
  }
  return out;
}

const problems = [];

for (const file of globSync(`${APP_DIR}/**/*.tsx`)) {
  const src = readFileSync(file, "utf8");
  for (const group of classGroups(src)) {
    const cls = group.join(" ");
    if (!cls.trim()) continue;

    // Conflicting dark values for one utility + variant set, judged per
    // LITERAL: the branches of a conditional are mutually exclusive at
    // runtime, so `active ? "dark:bg-blue-500" : "dark:bg-gray-800"` is
    // fine, while two such values in ONE branch let generated-CSS order
    // decide. The key is the CSS PROPERTY the family sets (text-gray-400 and
    // text-red-400 both set `color`), not the family: that is how a copied
    // `dark:text-red-400` rode along with `dark:text-gray-400` and silently
    // killed its hover twin.
    for (const literal of group) {
      const byKey = new Map();
      for (const d of literal.split(/\s+/).filter(Boolean)) {
        if (!d.startsWith("dark:")) continue;
        const b = bare(d);
        const variantKey = [...variants(d)]
          .sort((a, b) => a.localeCompare(b))
          .join("+");
        // A color utility is keyed by the PROPERTY its family sets, so
        // `dark:text-gray-400` and `dark:text-red-400` collide (both set
        // `color`) while `dark:ring-blue-400` and `dark:ring-offset-gray-900`
        // do not. Non-color utilities keep a finer key, or `border-2` and
        // `border-dashed` would look like the same property.
        const color = COLOR_UTILITY.exec(b);
        const key = color
          ? `${variantKey}:color:${color[1]}`
          : `${variantKey}:${b.split("-").slice(0, 2).join("-")}`;
        const existing = byKey.get(key);
        if (existing && existing !== d) {
          problems.push(
            `${file}: \`${literal}\` has conflicting dark variants \`${existing}\` and \`${d}\``,
          );
        } else {
          byKey.set(key, d);
        }
      }
    }

    // Every non-exempt color utility needs a dark twin of the same family
    // whose variant set covers it, IN ITS OWN LITERAL: the branches of a
    // conditional are mutually exclusive, so a twin in another branch never
    // applies in the browser and must not certify this one.
    for (const literal of group) {
      const literalDarks = literal
        .split(/\s+/)
        .filter((t) => t.startsWith("dark:"));
      for (const token of literal.split(/\s+/).filter(Boolean)) {
        if (token.startsWith("dark:")) continue;
        if (isExempt(token)) continue;
        const m = COLOR_UTILITY.exec(token);
        if (!m) continue;
        const family = m[1];
        const v = variants(token);
        const covered = literalDarks.some((d) => {
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
            `${file}: \`${literal}\` has \`${token}\` without a dark: twin (expected \`dark:${[...v].join(":")}:${bare(token)}\`)`,
          );
        }
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
