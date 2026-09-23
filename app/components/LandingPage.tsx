import {
  Bot,
  CreditCard,
  FolderOpen,
  MapPinned,
  Plug,
  ReceiptText,
  ShieldCheck,
  Sparkles,
  Tags,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MarketingCta } from "~/components/MarketingPage";
import { Button } from "~/components/ui/Button";
import { Card } from "~/components/ui/Card";
import { SitePage } from "~/components/SitePage";
import { EARLY_ACCESS_SPOTS, SITE_URL } from "~/lib/seo-content";
import { JsonLd } from "~/components/JsonLd";

/** Structured data for rich search results (Google reads JSON-LD). */
const SOFTWARE_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Expense",
  url: SITE_URL,
  image: `${SITE_URL}/screenshot-og.png`,
  description:
    "Expense reads your receipts, snapped, pasted, or forwarded from email, and files each expense into IRS Schedule C categories and reports, ready to export for tax season. Ask questions about your spending in the app and the answer is computed from your own records.",
  applicationCategory: "FinanceApplication",
  operatingSystem: "Web",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
  author: {
    "@type": "Person",
    name: "Assaf Arkin",
    url: "https://labnotes.org",
  },
};

/** The icons for the landing-page features, keyed by the benefit title so
 * the copy itself stays in app/data/about.yaml (the single source of the
 * site's public copy). Order here is the card order. */
const FEATURE_ICONS: Record<string, LucideIcon> = {
  "Stop losing receipts in your gallery": ReceiptText,
  "Connect your Fastmail account": Plug,
  "Get ready with your deductions on time": Tags,
  "PDF reports to show your accountant": FolderOpen,
  "Log drives without Excel": MapPinned,
  "Reconcile against your monthly statement": CreditCard,
  "Track the warranty, not just the purchase": ShieldCheck,
};

const STEPS = [
  {
    title: "Attach a receipt",
    body: "Simply upload the image, copy and paste the image, or even forward your receipt email to yourself. Receipt is automatically created.",
  },
  {
    title: "Save and confirm",
    body: "Merchant name, amount, and category are all automatically entered. Receipts just require a single click to save.",
  },
  {
    title: "Export when it's tax time",
    body: "Receive your report in PDF format with receipt attached, or ZIP of all receipts.",
  },
];

/** The four "bring your own assistant" examples on the landing page. */
const AGENT_EXAMPLES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: ReceiptText,
    title: "Extract a receipt from chat",
    body: "Drop a receipt photo or PDF into the conversation, and it's OCR'd, categorized from your own history, and filed. No app to open.",
  },
  {
    icon: Tags,
    title: "Inquire about your expenditures",
    body: `“How much have I spent on plane tickets this quarter?”—the precise amount, straight from the source.`,
  },
  {
    icon: FolderOpen,
    title: "Generate reports on demand",
    body: `“Insert all unreconciled June expenses into the Q2 report and save it as a PDF file.” One line of text, and it's done.`,
  },
  {
    icon: MapPinned,
    title: "Register a journey in natural language",
    body: `“Log the drive from the office back home on Tuesday.” Geocoded, routed, and costed at the IRS rates for the year.
`,
  },
];

/** The landing page's Insights sample: the questions are the ones the app
 * itself suggests (see insightStarters in app/lib/insights.ts), so nothing
 * here promises an ask the pipeline can't answer. */
const INSIGHTS_QUESTIONS = [
  "How much have I spent this year?",
  "Which report is the biggest this year?",
  "What still needs a report?",
  "What's my biggest expense?",
  "Where does my money go?",
];

const INSIGHTS_EXCHANGE = {
  question: "How much have I spent this year?",
  answer:
    "You spent $18,240.55 across 312 expenses. Q3 Travel is your biggest report at $4,180.20, and 6 expenses still have no report.",
};

/** The frame the marketing images sit in: rounded card, drop shadow, and the
 * traffic-light header that makes a screenshot read as a browser window. The
 * annotated receipt is artwork rather than app UI, so it drops the chrome.
 * `srcPortrait` is for artwork whose print stops being legible once the
 * viewport narrows to one column. `demo` plays a recording of the app inside
 * the same frame, with `src` as the still it paints first. */
function BrowserFrame({
  src,
  srcPortrait,
  alt,
  chrome = true,
  demo,
  children,
}: {
  src: string;
  srcPortrait?: string;
  alt: string;
  chrome?: boolean;
  /** The demo's sources; `src` is its poster and its reduced-motion still. */
  demo?: { mp4: string; webm: string };
  children?: ReactNode;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(true);

  // The video must not load for a visitor who will not see it: hidden is not
  // enough, a display:none autoplaying video still downloads in full. So the
  // element ships with no autoplay and preload="none", and playback starts
  // here, only when reduced motion is off. A refused play() (a data-saving
  // browser) leaves the control saying "Play demo", which is what it does.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const sync = () => setPlaying(!el.paused);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      if (reduce.matches) {
        el.pause();
        setPlaying(false);
      } else {
        el.muted = true;
        void el.play().catch(() => setPlaying(false));
      }
    };
    apply();
    el.addEventListener("play", sync);
    el.addEventListener("pause", sync);
    reduce.addEventListener("change", apply);
    return () => {
      el.removeEventListener("play", sync);
      el.removeEventListener("pause", sync);
      reduce.removeEventListener("change", apply);
    };
  }, []);

  function toggleDemo() {
    const el = video.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  }

  return (
    <figure className="overflow-hidden rounded-xl bg-white shadow-2xl shadow-gray-900/10 ring-1 ring-gray-900/5 dark:bg-gray-800 dark:shadow-black/30 dark:ring-white/5">
      {chrome ? (
        <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
          <span className="h-3 w-3 rounded-full bg-red-400" />
          <span className="h-3 w-3 rounded-full bg-amber-400" />
          <span className="h-3 w-3 rounded-full bg-green-400" />
          {demo ? (
            // A loop that starts on its own needs a way to stop it, so the
            // control lives in the frame's own chrome (and goes with the
            // video when a reduced-motion visitor gets the still instead).
            <button
              type="button"
              onClick={toggleDemo}
              className="ml-auto rounded px-2 py-0.5 text-xs font-medium text-gray-500 hover:bg-gray-200 hover:text-gray-900 motion-reduce:hidden dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
            >
              {playing ? "Pause demo" : "Play demo"}
            </button>
          ) : null}
        </div>
      ) : null}
      {demo ? (
        // The recording is the app itself: no controls of its own, nothing to
        // hear, and the still underneath. The box is sized up front so the
        // page does not reflow when the first frame lands.
        <div
          role="img"
          aria-label={alt}
          className="relative aspect-[1440/940] w-full"
        >
          <video
            ref={video}
            aria-hidden="true"
            className="absolute inset-0 h-full w-full object-cover object-top motion-reduce:hidden"
            muted
            loop
            playsInline
            preload="none"
            poster={src}
          >
            <source src={demo.webm} type="video/webm" />
            <source src={demo.mp4} type="video/mp4" />
          </video>
          <img
            src={src}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 hidden h-full w-full object-cover object-top motion-reduce:block"
          />
        </div>
      ) : srcPortrait ? (
        <picture className="block">
          <source media="(max-width: 639px)" srcSet={srcPortrait} />
          <img src={src} alt={alt} className="w-full" />
        </picture>
      ) : (
        <img src={src} alt={alt} className="w-full" />
      )}
      {children}
    </figure>
  );
}
export default function LandingPage({
  signupCount = 0,
  benefits,
}: {
  signupCount?: number;
  benefits: Array<{ title: string; body: string }>;
}) {
  const FEATURES: { icon: LucideIcon; title: string; body: string }[] =
    Object.keys(FEATURE_ICONS).map((title) => {
      const benefit = benefits.find((b) => b.title === title);
      // A missing title breaks the page instead of silently dropping a card;
      // the two lists can't drift apart without a loud error.
      if (!benefit) {
        throw new Error(
          `LandingPage feature "${title}" is missing from the benefits list in app/data/about.yaml`,
        );
      }
      return {
        icon: FEATURE_ICONS[title]!,
        title: benefit.title,
        body: benefit.body,
      };
    });

  return (
    <SitePage>
      <JsonLd data={SOFTWARE_SCHEMA} />

      <main>
        {/* Hero */}
        <section className="mx-auto max-w-4xl px-4 pb-16 pt-12 text-center sm:px-6 sm:pt-16">
          <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-blue-600 dark:text-blue-400">
            Expense tracking for tax season
          </p>
          <h1 className="text-4xl font-black tracking-tight text-ink sm:text-5xl lg:text-6xl">
            Every receipt, ready for tax season.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-gray-600 dark:text-gray-300">
            Your receipts, all collected to prepare for tax season. Expense does
            that for you: take a picture of it, drop a screenshot or a receipt
            email. OCR recognizes the merchant and amount and puts the spend
            into the correct category of a Schedule C form and a report of your
            choice. And when tax season comes, all is ready.
          </p>
          <p className="mx-auto mt-3 max-w-2xl text-base text-gray-500 dark:text-gray-400">
            Have a Fastmail account? Connect it and receipts from your inbox are
            processed automatically, no forwarding and no Gmail required.
          </p>
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
            By a freelancer. Open-source, no funding.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button asChild size="lg" className="w-full sm:w-auto">
              <Link to="/login?mode=create">Create your account</Link>
            </Button>
          </div>
          <p className="mt-5 text-sm text-gray-500 dark:text-gray-400">
            No credit card required. Your data stays in your account. Export and
            leave anytime.
          </p>
          {signupCount > 0 ? (
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
              {signupCount} of {EARLY_ACCESS_SPOTS} free spots claimed.
            </p>
          ) : null}
        </section>

        {/* App demo */}
        <section className="mx-auto max-w-5xl px-4 pb-20 sm:px-6">
          {/*
           * The note is decoration: it lives in a pseudo-element, so it adds
           * nothing to the accessibility tree, and it never points inside the
           * frame, which the demo script regenerates. The section's own pb-20
           * is the room it sits in.
           */}
          <span
            className="ann ann-n ann-blue ann-no-mark ann-block ann-wide"
            data-note="the real app, recorded"
          >
            <BrowserFrame
              src="/demo-receipt-poster.webp"
              alt="A receipt PDF dropped on the expense list becomes a filed expense: the merchant, amount and category are read from it, and saving the expense puts it on the list"
              demo={{ mp4: "/demo-receipt.mp4", webm: "/demo-receipt.webm" }}
            />
          </span>
        </section>

        {/* Features */}
        <section
          id="features"
          className="border-t border-gray-100 bg-gray-50 py-20 dark:border-gray-800 dark:bg-gray-800/50"
        >
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <h2 className="text-center text-3xl font-bold tracking-tight text-ink">
              What you get
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-center text-gray-600 dark:text-gray-300">
              Tailored for one purpose: to get your expense data as quickly as
              possible, so year-end is not a grueling process but just a
              download.
            </p>
            <div className="mx-auto mt-12 flex max-w-2xl flex-col gap-3">
              {FEATURES.map((f) => (
                <Card key={f.title} className="flex items-start gap-4 p-5">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-700">
                    <f.icon aria-hidden="true" className="h-5 w-5 text-ink" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-ink">{f.title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                      {f.body}
                    </p>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        </section>

        {/* Insights */}
        <section className="mx-auto max-w-5xl px-4 pb-20 sm:px-6">
          <h2 className="text-3xl font-bold tracking-tight text-ink">
            Ask your expenses a question
          </h2>
          <p className="mt-3 max-w-2xl text-gray-600 dark:text-gray-300">
            Insights answers from your own records, not from a model's memory:
            every number is computed from your expenses. The longer you use
            Expense, the more it has to work with.
          </p>
          <p className="mt-8 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Example
          </p>
          <div className="mt-3 flex flex-col gap-2">
            <Card className="p-4">
              <p className="text-sm font-medium text-gray-800 dark:text-gray-100">
                {INSIGHTS_EXCHANGE.question}
              </p>
            </Card>
            <Card className="border-gray-100 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {INSIGHTS_EXCHANGE.answer}
              </p>
            </Card>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-1.5 text-sm">
            {INSIGHTS_QUESTIONS.filter(
              (q) => q !== INSIGHTS_EXCHANGE.question,
            ).map((q) => (
              <span
                key={q}
                className="rounded-full border border-gray-300 px-2.5 py-0.5 text-gray-600 dark:border-gray-600 dark:text-gray-300"
              >
                {q}
              </span>
            ))}
          </div>
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
            Only answers what your data supports. When it can't, it says so.
          </p>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            Next: summaries that arrive on their own when your spending changes.
          </p>
        </section>

        {/* How it works */}
        <section
          id="how-it-works"
          className="mx-auto max-w-6xl px-4 py-20 sm:px-6"
        >
          <h2 className="text-3xl font-bold tracking-tight text-ink">
            From receipt to export
          </h2>
          <p className="mt-3 max-w-md text-gray-600 dark:text-gray-300">
            Just three fast moves, no data input required.
          </p>
          <ol className="mt-10 grid gap-8 sm:grid-cols-3">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-4">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-sm font-bold text-blue-600 dark:bg-blue-900/60 dark:text-blue-400">
                  {i + 1}
                </span>
                <div>
                  <h3 className="font-semibold text-ink">{step.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                    {step.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          {/*
           * The annotated receipt rather than a screenshot of the editor: it
           * reads at a glance what the three steps do. Its artwork is 1200px
           * wide with 17px receipt text, so it takes the full column instead
           * of a grid half, where that text would land around 8px.
           */}
          <BrowserFrame
            chrome={false}
            src="/figure-receipt.png"
            srcPortrait="/figure-receipt-portrait.png"
            alt="A receipt with hand-drawn notes: the merchant and the total called out, and the expense filed under the Meals and entertainment category"
          >
            <figcaption className="flex items-center gap-2 border-t border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-300">
              <Sparkles
                aria-hidden="true"
                className="h-4 w-4 text-blue-600 dark:text-blue-400"
              />
              OCR and AI filled in merchant, amount, and category.
            </figcaption>
          </BrowserFrame>
        </section>

        {/* AI assistants */}
        <section
          id="ai-assistants"
          className="mx-auto max-w-6xl px-4 pb-20 sm:px-6"
        >
          <Card className="rounded-2xl p-8 sm:p-12">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
              <Bot aria-hidden="true" className="h-4 w-4" /> AI-native
            </div>
            <h2 className="mt-2 text-3xl font-bold tracking-tight text-ink">
              Your Own Personal AI Assistant
            </h2>
            <p className="mt-3 max-w-2xl text-gray-600 dark:text-gray-300">
              Expense uses the Model Context Protocol (MCP). Simply point
              Claude, OpenAI, or any other MCP client to your account, log in
              for authentication (no tokens to deal with), and let the assistant
              do the mundane work. In Chrome, the app also registers in-page
              tools so the browser's own agent can read your expenses without
              any setup:
            </p>
            <ul className="mt-6 grid gap-4 sm:grid-cols-2">
              {AGENT_EXAMPLES.map((example) => (
                <li
                  key={example.title}
                  className="flex gap-3 rounded-xl border border-gray-100 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50"
                >
                  <example.icon
                    aria-hidden="true"
                    className="h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400"
                  />
                  <div>
                    <h3 className="text-sm font-semibold text-ink">
                      {example.title}
                    </h3>
                    <p className="mt-1 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                      {example.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-6 text-sm text-gray-500 dark:text-gray-400">
              Connection is authorization: the assistant opens the browser, you
              allow access, and it is connected. Disconnect any time with one
              click in the Settings menu.
            </p>
          </Card>
        </section>

        {/* CTA */}
        <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
          {/* The landing page's closing panel is the page's final moment:
           * larger heading, taller padding, transparent Sign in. */}
          <MarketingCta
            heading="Start collecting this year's expenses."
            body="No credit card, no subscription, no ads."
            secondaryLabel="Sign in"
            secondaryHref="/login"
            className="py-14"
            headingClassName="text-3xl"
            secondaryClassName="bg-transparent"
          />
        </section>
      </main>
    </SitePage>
  );
}
