import {
  ChevronLeft,
  ChevronRight,
  Command,
  CreditCard,
  FileText,
  Fuel,
  Keyboard,
  Mail,
  MapPinned,
  Search,
  Tags,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "~/components/ui/Button";
import { Card } from "~/components/ui/Card";

interface Tip {
  icon: LucideIcon;
  title: string;
  body: ReactNode;
}

/** Tips for signed-out visitors on the landing page (signed-in users get the
 * rotating "Did you know?" card on the home page instead). Destinations are
 * inline links in the prose, so the slides carry no buttons. */
const TIPS: Tip[] = [
  {
    icon: Tags,
    title: "IRS Schedule C categories",
    body: (
      <>
        Expenses start with the{" "}
        <Link
          to="/schedule-c-categories"
          className="underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500 dark:decoration-gray-600"
        >
          IRS Schedule C categories
        </Link>
        ; add your own in{" "}
        <Link
          to="/settings#categories"
          className="underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500 dark:decoration-gray-600"
        >
          Settings
        </Link>
        .
      </>
    ),
  },
  {
    icon: Fuel,
    title: "Mileage, converted for you",
    body: (
      <>
        Every drive is priced at the IRS rate for its date; every rate since
        2011 is on the{" "}
        <Link
          to="/mileage-rates"
          className="underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500 dark:decoration-gray-600"
        >
          mileage rates page
        </Link>
        .
      </>
    ),
  },
  {
    icon: MapPinned,
    title: "Every drive is a round trip",
    body: (
      <>
        Set a{" "}
        <Link
          to="/settings#start-location"
          className="underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500 dark:decoration-gray-600"
        >
          start location
        </Link>{" "}
        and drives are measured from there and back.
      </>
    ),
  },
  {
    icon: Mail,
    title: "Email a receipt, skip the app",
    body: (
      <>
        Forward a receipt email to your{" "}
        <Link
          to="/emails"
          className="underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500 dark:decoration-gray-600"
        >
          inbound address
        </Link>{" "}
        and it imports itself, PDFs and images included.
      </>
    ),
  },
  {
    icon: Command,
    title: "Live in the keyboard",
    body: (
      <>
        ⌘K opens the command palette; g then r jumps to Reports, a starts a new
        receipt.
      </>
    ),
  },
  {
    icon: Search,
    title: "Search like a pro",
    body: (
      <>
        Prefix your search to stack filters: report: Q3, category: meals,
        merchant: Amazon.
      </>
    ),
  },
  {
    icon: CreditCard,
    title: "Catch every deduction",
    body: (
      <>
        <Link
          to="/reconcile"
          className="underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500 dark:decoration-gray-600"
        >
          Upload a statement
        </Link>{" "}
        and Expense matches it against your logged expenses.
      </>
    ),
  },
  {
    icon: FileText,
    title: "Reports, ready to file",
    body: (
      <>
        Create as many reports as you need and{" "}
        <Link
          to="/export"
          className="underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500 dark:decoration-gray-600"
        >
          export any of them as a PDF
        </Link>
        .
      </>
    ),
  },
  {
    icon: Keyboard,
    title: "Shortcuts, on screen",
    body: <>Press Shift+? and the keys pin next to the buttons they drive.</>,
  },
];

const DISMISS_KEY = "tips-dismissed";
const ADVANCE_MS = 5000;

/** Fixed tips carousel near the bottom of the viewport on the landing page:
 * advances on its own every 5 seconds (pausing while hovered or focused, and
 * never auto-advancing for reduced-motion users), with prev/next and dots to
 * move manually. Slides carry no buttons; dismiss persists in localStorage. */
export function TipsSlider() {
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (localStorage.getItem(DISMISS_KEY)) setDismissed(true);
  }, []);
  useEffect(() => {
    if (paused) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(
      () => setIndex((i) => (i + 1) % TIPS.length),
      ADVANCE_MS,
    );
    return () => clearInterval(id);
  }, [paused]);
  if (dismissed) return null;
  const { icon: Icon, title, body } = TIPS[index];
  return (
    <div className="fixed inset-x-4 bottom-4 z-40 mx-auto max-w-2xl">
      <div className="relative">
        <Card
          className="p-4"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocusCapture={() => setPaused(true)}
          onBlurCapture={() => setPaused(false)}
        >
          <button
            type="button"
            onClick={() => {
              localStorage.setItem(DISMISS_KEY, "1");
              setDismissed(true);
            }}
            aria-label="Dismiss tips"
            className="absolute right-1 top-1 rounded-md p-2 text-gray-400 hover:text-gray-600 focus-visible:outline-2 focus-visible:outline-offset-2 dark:hover:text-gray-300"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
          <div className="flex items-start gap-3" aria-live="polite">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-gray-800 dark:text-blue-400">
              <Icon aria-hidden="true" className="h-4 w-4" />
            </span>
            <div className="min-w-0 pr-6" key={index}>
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Tip {index + 1} of {TIPS.length}
              </p>
              <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                {title}
              </p>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {body}
              </p>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between pl-12">
            <div className="flex items-center gap-1">
              {TIPS.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setIndex(i)}
                  aria-label={`Go to tip ${i + 1}`}
                  aria-current={i === index}
                  className={`h-1.5 rounded-full transition-all ${
                    i === index
                      ? "w-4 bg-blue-600 dark:bg-blue-400"
                      : "w-1.5 bg-gray-300 hover:bg-gray-400 dark:bg-gray-600 dark:hover:bg-gray-500"
                  }`}
                />
              ))}
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setIndex((i) => (i - 1 + TIPS.length) % TIPS.length)
                }
                aria-label="Previous tip"
              >
                <ChevronLeft aria-hidden="true" className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIndex((i) => (i + 1) % TIPS.length)}
                aria-label="Next tip"
              >
                <ChevronRight aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
