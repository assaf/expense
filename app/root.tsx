import type { LinksFunction } from "react-router";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
} from "react-router";
import "~/global.css";
import { requireUser } from "~/lib/auth.server";
import type { Route } from "./+types/root";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  // The login route and the inbound email webhook are public; everything
  // else requires a session (the webhook verifies its own Resend signature).
  const isPublic =
    url.pathname.startsWith("/login") ||
    url.pathname.startsWith("/api/inbound-email");
  if (!isPublic) {
    await requireUser(request);
  }
  return null;
}

export function meta(): Route.MetaDescriptors {
  return [
    { title: "Expense tracking" },
    {
      name: "description",
      content: "Personal expense tracking with receipts and mileage.",
    },
  ];
}

export const links: LinksFunction = () => [
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
  },
];

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const message = isRouteErrorResponse(error)
    ? error.statusText || error.data
    : "Something went wrong.";

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${status} — Expense`}</title>
        <Links />
      </head>
      <body>
        <main className="mx-auto flex max-w-xl flex-col items-center gap-2 px-4 py-24">
          <h1 className="text-4xl font-bold text-red-600">{status}</h1>
          <p className="text-gray-500">{String(message)}</p>
          <a href="/" className="mt-4 text-blue-600 underline">
            Back to expenses
          </a>
        </main>
        <Scripts />
      </body>
    </html>
  );
}
