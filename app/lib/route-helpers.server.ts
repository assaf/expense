import type { User } from "~/lib/types";
import { requireUser } from "~/lib/auth.server";
import { CRON_SECRET } from "~/lib/env";
import { safeEqual } from "~/lib/passwords";
import { formString } from "~/lib/validation";

/**
 * Authenticated action preamble shared by every form route:
 * requireUser -> parse FormData -> read the "intent" field.
 */
export async function requireIntent(request: Request): Promise<{
  user: User;
  form: FormData;
  intent: string;
}> {
  const user = await requireUser(request);
  const { form, intent } = await parseIntent(request);
  return { user, form, intent };
}

/**
 * FormData + "intent" read shared by anonymous form routes (onboarding):
 * requireIntent minus the session requirement.
 */
export async function parseIntent(request: Request): Promise<{
  form: FormData;
  intent: string;
}> {
  const form = await request.formData();
  return { form, intent: formString(form, "intent") };
}

/**
 * Guard for cron routes: Vercel Cron sends `Authorization: Bearer
 * <CRON_SECRET>` only when the env var is set, so an unset secret means
 * the route is unreachable in that deployment. Returns a 401 response to
 * bail with, or undefined when the request is authenticated.
 */
export function assertCronSecret(request: Request): Response | undefined {
  const secret = CRON_SECRET;
  if (
    !secret ||
    !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return undefined;
}

/** Map an OAuth entry route's raw `?next=` value to its resume path. An
 * allowlist token, never a path, so the route can't become an open
 * redirect; anything unknown defaults to onboarding. Shared by the
 * Fastmail and Gmail connect/callback route pairs. */
export function oauthResumePath(raw: string | null): string {
  return raw === "emails" ? "/emails" : "/onboarding";
}
