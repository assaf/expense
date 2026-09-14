import { redirect } from "react-router";

/**
 * GET /.well-known/change-password: the W3C change-password URL
 * (https://w3c.github.io/webappsec-change-password-url/). Password managers
 * and OS password tools look it up on the origin to find the page that
 * changes the password, so it answers without a session, and the spec pins
 * the response: a temporary redirect (302, 303 or 307; a permanent one is
 * wrong) pointing at the page with the form. Serving the form itself from
 * this path is explicitly not allowed.
 *
 * The form is the Password section of Settings. Anonymous callers land there
 * through the usual /login bounce, which is the honest answer for a tool that
 * arrives without a session.
 */
export function loader() {
  return redirect("/settings#change-password", { status: 302 });
}
