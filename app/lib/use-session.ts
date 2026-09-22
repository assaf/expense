import { useEffect, useState } from "react";
import { useRouteLoaderData } from "react-router";
import type { loader as rootLoader } from "~/root";

/** The session as the client can see it: the signed-in user (id only) and the
 * report names the palette's export submenu needs. */
export interface Session {
  user: { id: string } | null;
  reportNames: string[];
}

/** One fetch per page load, shared by every consumer (the root shell, the
 * public chrome, the CTA panel all ask): a client-side navigation between two
 * public pages must not re-ask. */
let pending: Promise<Session> | null = null;

function fetchSession(): Promise<Session> {
  pending ??= (async () => {
    try {
      const res = await fetch("/api/session");
      return res.ok
        ? ((await res.json()) as Session)
        : { user: null, reportNames: [] };
    } catch {
      // Offline or blocked: the page stays in its anonymous shape, which is
      // what the shared cache served anyway.
      return { user: null, reportNames: [] };
    }
  })();
  return pending;
}

/**
 * The session for the current page. App pages get it from the root loader,
 * which resolves the user before the render (so the shell is server-rendered
 * and never flips). Public pages get it from /api/session after hydration:
 * their document is shared-cached and identical for everyone, so the session
 * cannot be in it - the chrome paints "Sign in" and swaps to "Dashboard" once
 * the answer arrives.
 *
 * Like every `useRouteLoaderData` call this needs a data router, which the app
 * always renders in.
 */
export function useSession(): Session {
  const deferred =
    useRouteLoaderData<typeof rootLoader>("root")?.deferredSession ?? false;
  const [late, setLate] = useState<Session | null>(null);

  useEffect(() => {
    if (!deferred) return;
    let cancelled = false;
    void fetchSession().then((session) => {
      if (!cancelled) setLate(session);
    });
    return () => {
      cancelled = true;
    };
  }, [deferred]);

  if (!deferred) {
    const root = useRouteLoaderData<typeof rootLoader>("root");
    return {
      user: root?.user ?? null,
      reportNames: root?.reportNames ?? [],
    };
  }
  return late ?? { user: null, reportNames: [] };
}
