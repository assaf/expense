/** Horizontal rule with a label ("Or") centered in the gap: separates two
 * equal-weight connect paths (e.g. Gmail OAuth above, Fastmail below). */
export function OrDivider({ label = "Or" }: { label?: string }) {
  return (
    <div
      role="separator"
      aria-label={label}
      className="flex items-center gap-3"
    >
      <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
      <span className="text-xs text-gray-500 dark:text-gray-400">{label}</span>
      <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
    </div>
  );
}
