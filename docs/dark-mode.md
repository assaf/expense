# Dark mode

System-only via `prefers-color-scheme`, no toggle. The
`@custom-variant dark (&:is(.dark *))` in `app/global.css` is already wired;
an inline `<script>` in `app/root.tsx` applies `.dark` to `<html>` before
first paint (FOUC-free) and listens for live OS theme changes. **Every new
component must add `dark:` variants for all color classes**: background,
text, border, ring, placeholder, hover, and focus states. Use these
mappings:

- Backgrounds: `bg-white` → `dark:bg-gray-800`, `bg-gray-50` →
  `dark:bg-gray-900`, `bg-gray-100` → `dark:bg-gray-700`
- Text: `text-gray-500` → `dark:text-gray-400`, `text-gray-600` →
  `dark:text-gray-300`, `text-gray-700` → `dark:text-gray-200`,
  `text-gray-800` → `dark:text-gray-100`
- Borders: `border-gray-100` → `dark:border-gray-800`,
  `border-gray-200` → `dark:border-gray-700`,
  `border-gray-300` → `dark:border-gray-600`
- Accent backgrounds: `bg-blue-50` → `dark:bg-gray-800`,
  `bg-amber-50` → `dark:bg-amber-950`, `bg-green-50` →
  `dark:bg-green-950`, `bg-red-50` → `dark:bg-red-950`
- Accent text: `text-blue-600` → `dark:text-blue-400`,
  `text-amber-700` → `dark:text-amber-400`,
  `text-green-700` → `dark:text-green-400`,
  `text-red-600` → `dark:text-red-400`
- Hover: `hover:bg-gray-100` → `dark:hover:bg-gray-800`,
  `hover:bg-black/5` → `dark:hover:bg-white/5`
- Focus rings: `focus:ring-blue-500` → `dark:focus:ring-blue-400`,
  `ring-offset-white` → `dark:ring-offset-gray-900`
- Do NOT use `bg-ink` or `text-ink` in dark mode; `--color-ink` is a
  CSS custom property that resolves to different values per theme.
  Prefer concrete Tailwind colors wherever possible.
- Shared UI primitives (`Button`, `Input`, `Textarea`, `Select`,
  `Card`, `EmptyState`) already have dark variants. Use them instead of
  raw elements where possible.
