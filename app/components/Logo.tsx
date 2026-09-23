/**
 * The Expense logo. Renders the icon mark + "🧾 Expense" as selectable
 * DOM text so double-click → copy works reliably.
 *
 * `icon`: just the icon mark (footer, favicon-like spots). Still uses
 *   alt text for copy behavior there.
 * `link`: wraps in a clickable link, to `href` (the marketing home by
 *   default; the app passes /expenses, its own home).
 * `shortcut`: the kbar action id this link stands for, when it is the
 *   control the app's keyboard chord drives (the home logo and G E). The
 *   Shift+? hint layer positions that action's keycap on the anchor.
 */
export function Logo({
  icon = false,
  link = false,
  href = "/",
  shortcut,
}: {
  icon?: boolean;
  link?: boolean;
  /** Where a linked mark points. */
  href?: string;
  /** `data-shortcut` anchor for the Shift+? hint layer. */
  shortcut?: string;
}) {
  if (icon) {
    const img = (
      <img
        src="/logo-icon-192.png"
        alt="Expense"
        className="h-8 w-8"
        draggable={false}
      />
    );
    if (!link) return img;
    return (
      <a
        href={href}
        data-shortcut={shortcut}
        className="inline-flex rounded-lg"
      >
        {img}
      </a>
    );
  }

  const content = (
    <>
      <img
        src="/logo-icon-192.png"
        alt=""
        aria-hidden="true"
        className="h-8 w-8 flex-shrink-0 sm:h-10 sm:w-10"
        draggable={false}
      />
      <span className="text-2xl font-bold text-brand-navy select-text sm:text-3xl dark:text-gray-100">
        Expense
      </span>
    </>
  );

  if (!link)
    return (
      <span className="inline-flex items-center gap-2 sm:gap-2.5">
        {content}
      </span>
    );
  return (
    <a
      href={href}
      data-shortcut={shortcut}
      className="inline-flex items-center gap-2 sm:gap-2.5 rounded-lg"
    >
      {content}
    </a>
  );
}
