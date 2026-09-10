/**
 * The Expense logo. Renders the icon mark + "🧾 Expense" as selectable
 * DOM text so double-click → copy works reliably.
 *
 * `icon`: just the icon mark (footer, favicon-like spots). Still uses
 *   alt text for copy behavior there.
 * `link`: wraps in a clickable link to "/".
 */
export function Logo({
  icon = false,
  link = false,
}: {
  icon?: boolean;
  link?: boolean;
}) {
  if (icon) {
    const img = (
      <img
        src="/logo-icon.svg"
        alt="Expense"
        className="h-8 w-8"
        draggable={false}
      />
    );
    if (!link) return img;
    return (
      <a href="/" className="inline-flex rounded-lg">
        {img}
      </a>
    );
  }

  const content = (
    <>
      <img
        src="/logo-icon.svg"
        alt=""
        aria-hidden="true"
        className="h-8 w-8 flex-shrink-0 sm:h-10 sm:w-10"
        draggable={false}
      />
      <span className="text-2xl font-bold text-teal-600 select-text sm:text-3xl">
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
      href="/"
      className="inline-flex items-center gap-2 sm:gap-2.5 rounded-lg"
    >
      {content}
    </a>
  );
}
