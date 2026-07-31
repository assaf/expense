import { redirect } from "react-router";
import { logout } from "~/lib/auth.server";
import type { Route } from "./+types/sign-out";

export async function action({ request }: Route.ActionArgs) {
  const cookie = await logout(request);
  throw redirect("/login", { headers: { "Set-Cookie": cookie } });
}
