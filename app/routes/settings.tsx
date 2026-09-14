import { useEffect, useMemo, useState } from "react";
import { Check, LogOut, RefreshCw, Settings, Trash2 } from "lucide-react";
import { Form, redirect, useFetcher } from "react-router";
import { Button } from "~/components/ui/Button";
import { Badge } from "~/components/ui/Badge";
import { Card } from "~/components/ui/Card";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Field } from "~/components/ui/Field";
import { FieldLabel } from "~/components/ui/FieldLabel";
import { Input } from "~/components/ui/Input";
import { Section } from "~/components/ui/Section";
import { StatusNote } from "~/components/ui/StatusNote";
import { PageShell } from "~/components/PageShell";
import { AgentsSection } from "~/components/settings/agents-section";
import { CategoryRow, NameList } from "~/components/settings/name-list";
import { LocationsList } from "~/components/settings/locations-list";
import { PasswordSection } from "~/components/settings/password-section";
import { SignInEmailForm } from "~/components/settings/sign-in-email";
import {
  changeEmail,
  changePassword,
  confirmPassword,
  logout,
  requireUser,
} from "~/lib/auth.server";
import { requireIntent } from "~/lib/route-helpers.server";
import { geocode } from "~/lib/maps.server";
import {
  closeUserAccount,
  readAccountFootprint,
  readAccount,
  readAccountUsers,
  readUserEmail,
  regenerateInviteCode,
  readMarketingUnsubscribed,
  resubscribeMarketingEmail,
  unsubscribeMarketingEmail,
  type AccountFootprint,
} from "~/lib/db/accounts";
import {
  addCategory,
  readCategories,
  removeCategory,
  renameCategory,
} from "~/lib/db/categories";
import {
  addLocation as addLocationRow,
  boundAddress,
  readLocations,
  removeLocation as removeLocationRow,
  updateLocation as updateLocationRow,
} from "~/lib/db/locations";
import { MAX_ADDRESS_LENGTH } from "~/lib/types";
import { disconnectOAuthClient, listUserOAuthSessions } from "~/lib/db/oauth";
import { readCategoryCounts } from "~/lib/db/reports";
import { readMileageRates } from "~/lib/db/seed";
import { readSettings, writeSettings } from "~/lib/db/settings";
import { LocalDate } from "~/components/ui/LocalTime";
import { useToday } from "~/lib/use-today";
import {
  MILEAGE_TYPE_LABELS,
  MILEAGE_TYPES,
  currentMileageRates,
  formatRate,
  periodLabel,
} from "~/lib/mileage-rates";
import { formString, unknownIntent } from "~/lib/validation";
import type { Route } from "./+types/settings";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const account = await readAccount(user.accountId);
  const [
    categories,
    settings,
    categoryCounts,
    oauthSessions,
    rates,
    members,
    locations,
    footprint,
    email,
  ] = await Promise.all([
    readCategories(user.accountId),
    readSettings(user.accountId),
    readCategoryCounts(user.accountId),
    listUserOAuthSessions(user.id),
    readMileageRates(),
    readAccountUsers(user.accountId),
    readLocations(user.accountId),
    readAccountFootprint(user.accountId),
    // Not user.email: the section that shows this address is the one a change
    // lands on, and the id→user cache can still hold the previous address for
    // its TTL (another instance may answer the redirect).
    readUserEmail(user.id),
  ]);
  // The "current rate" line is computed CLIENT-side from the browser's
  // local today; the server runs UTC and must not guess the user's day.
  // The rates table itself is passed through (timezone-independent).
  return {
    accountName: account?.name ?? "",
    inviteCode: account?.inviteCode ?? "",
    categories: categories.map((c) => ({
      name: c.name,
      count: categoryCounts.get(c.name) ?? 0,
    })),
    homeAddress: settings.homeAddress,
    locations,
    userEmail: email ?? user.email,
    marketingUnsubscribed: await readMarketingUnsubscribed(user.id),
    footprint,
    rates,
    oauthSessions,
    members,
    mcpUrl: new URL("/mcp", request.url).toString(),
  };
}

export function meta(): Route.MetaDescriptors {
  return [{ title: "Settings — Expense" }];
}

/** The sentence under "Close account": what the button actually does right
 * now, with the live counts. Each clause is dropped when its count is zero,
 * and trips only apply to the last-member case (a shared account keeps them
 * either way). */
function closeAccountSummary(footprint: AccountFootprint): string {
  const parts: string[] = [];
  if (footprint.receipts > 0) {
    parts.push(
      `${footprint.receipts} receipt${footprint.receipts === 1 ? "" : "s"}`,
    );
  }
  if (footprint.members === 1 && footprint.trips > 0) {
    parts.push(`${footprint.trips} trip${footprint.trips === 1 ? "" : "s"}`);
  }
  if (footprint.reports > 0) {
    parts.push(
      `${footprint.reports} report${footprint.reports === 1 ? "" : "s"}`,
    );
  }
  if (footprint.mailboxes > 0) {
    parts.push(
      `${footprint.mailboxes} connected mailbox${footprint.mailboxes === 1 ? "" : "es"}`,
    );
  }
  const listed =
    parts.length < 2
      ? (parts[0] ?? "")
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]!}`;
  if (footprint.members === 1) {
    return `Close your account and everything in it is deleted${listed ? `: ${listed}` : ""}.`;
  }
  const others = footprint.members - 1;
  return [
    "Close your account and your login, apps and receipts-by-email address are removed.",
    listed
      ? `The account's ${listed} stay with its other ${others} member${others === 1 ? "" : "s"}.`
      : "",
    footprint.mailboxes
      ? "Mailboxes connected to this account keep importing until someone disconnects them."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export async function action({ request }: Route.ActionArgs) {
  const { user, form, intent } = await requireIntent(request);

  switch (intent) {
    case "regenerateCode":
      await regenerateInviteCode(user.accountId);
      break;
    case "addCategory": {
      const name = formString(form, "name").trim();
      const result = await addCategory(user.accountId, name);
      return Response.json(result.ok ? { ok: true, name } : result);
    }
    case "removeCategory":
      await removeCategory(user.accountId, formString(form, "name"));
      break;
    case "renameCategory": {
      const result = await renameCategory(
        user.accountId,
        formString(form, "name"),
        formString(form, "newName"),
      );
      return Response.json(result);
    }
    case "disconnectOAuthClient": {
      const clientId = formString(form, "clientId");
      if (clientId) await disconnectOAuthClient(user.id, clientId);
      return Response.json({ ok: true });
    }
    case "saveHome": {
      const settings = await readSettings(user.accountId);
      // The home field has no error surface (a plain form post), so the
      // stored value stays clamped; the input caps the length client-side,
      // so only a hand-made request ever reaches this.
      const address = boundAddress(formString(form, "homeAddress"));
      settings.homeAddress = address;
      if (address) {
        const geocoded = await geocode(address);
        settings.homeLat = geocoded.lat;
        settings.homeLng = geocoded.lng;
      } else {
        settings.homeLat = null;
        settings.homeLng = null;
      }
      await writeSettings(user.accountId, settings);
      break;
    }
    case "addLocation": {
      const address = formString(form, "address").trim();
      if (address.length > MAX_ADDRESS_LENGTH) {
        // Refused rather than truncated: a clamped address would be geocoded
        // as a prefix, so the saved place could sit somewhere else.
        return Response.json({
          ok: false,
          error: "That address is too long — keep it under 300 characters.",
        });
      }
      const geocoded = address ? await geocode(address) : null;
      const result = await addLocationRow(user.accountId, {
        name: formString(form, "name"),
        address,
        lat: geocoded?.lat ?? null,
        lng: geocoded?.lng ?? null,
      });
      return Response.json(
        result.ok
          ? {
              ok: true,
              id: result.location.id,
              name: result.location.name,
              geocoded: result.location.lat !== null,
            }
          : result,
      );
    }
    case "updateLocation": {
      const address = formString(form, "address").trim();
      if (address.length > MAX_ADDRESS_LENGTH) {
        return Response.json({
          ok: false,
          error: "That address is too long — keep it under 300 characters.",
        });
      }
      const geocoded = address ? await geocode(address) : null;
      const result = await updateLocationRow(
        user.accountId,
        formString(form, "id"),
        {
          name: formString(form, "name"),
          address,
          lat: geocoded?.lat ?? null,
          lng: geocoded?.lng ?? null,
        },
      );
      return Response.json(
        result.ok
          ? {
              ok: true,
              id: result.location.id,
              name: result.location.name,
              geocoded: result.location.lat !== null,
            }
          : result,
      );
    }
    case "removeLocation":
      await removeLocationRow(user.accountId, formString(form, "id"));
      break;
    case "marketingEmails": {
      const preference = formString(form, "preference");
      if (preference === "unsubscribe") {
        await unsubscribeMarketingEmail(user.id);
      } else if (preference === "resubscribe") {
        await resubscribeMarketingEmail(user.id);
      } else {
        return unknownIntent();
      }
      break;
    }
    // Same shape as changePassword: a refusal answers JSON for the inline
    // error, success navigates so the card re-renders with the new address
    // and the confirmation. No cookie here: the session, the password and the
    // credentials epoch are untouched by an email change.
    case "changeEmail": {
      const result = await changeEmail(
        user,
        formString(form, "email"),
        formString(form, "password"),
        new URL(request.url).origin,
      );
      if (!result.ok) return Response.json(result);
      return redirect("/settings?email=changed#sign-in-email");
    }
    // Refusals come back as JSON so the section can show the reason inline
    // (a wrong current password, a mismatch, a too-short new one). Success
    // navigates instead of answering JSON: password managers watch the
    // submission to decide the change worked and the new password is worth
    // saving (Chrome's automated password change is explicit about wanting a
    // navigation), and the response re-mints this device's session cookie so
    // the navigation stays signed in.
    case "changePassword": {
      const newPassword = formString(form, "newPassword");
      if (newPassword !== formString(form, "confirmPassword")) {
        return Response.json({
          ok: false,
          error: "Those passwords don't match.",
        });
      }
      const result = await changePassword(
        user,
        formString(form, "currentPassword"),
        newPassword,
      );
      if (!result.ok) return Response.json(result);
      return redirect("/settings?password=changed#change-password", {
        headers: { "Set-Cookie": result.cookie },
      });
    }
    // JSON rather than a redirect, so a wrong password leaves the dialog open
    // with its inline error. On success the cookie is cleared in the same
    // response and the client does a full navigation (see the page component).
    case "closeAccount": {
      const confirmed = await confirmPassword(
        user,
        formString(form, "password"),
      );
      if (!confirmed.ok) return Response.json(confirmed);
      const outcome = await closeUserAccount({
        id: user.id,
        accountId: user.accountId,
        email: user.email,
      });
      return Response.json(
        { ok: true, ...outcome },
        { headers: { "Set-Cookie": await logout(request) } },
      );
    }
    default:
      return unknownIntent();
  }
  return redirect("/settings");
}

export default function SettingsPage({ loaderData }: Route.ComponentProps) {
  const {
    categories,
    homeAddress,
    locations,
    rates,
    accountName,
    inviteCode,
    userEmail,
    oauthSessions,
    members,
    mcpUrl,
    marketingUnsubscribed,
    footprint,
  } = loaderData;
  // The "current rate" line depends on the browser's local today (the
  // server runs UTC); computed client-side after mount.
  const today = useToday();
  const currentRates = useMemo(
    () => (today ? currentMileageRates(rates, today) : null),
    [today, rates],
  );
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [closePassword, setClosePassword] = useState("");
  const closeFetcher = useFetcher<{
    ok?: true;
    deleted?: "account" | "user";
    error?: string;
  }>();
  // The account (and this session) is gone once the action succeeds, so the
  // whole route tree has to re-resolve anonymously: a fetch-based redirect
  // would leave the root loader's cached user in place. The landing notice
  // tells the two outcomes apart.
  useEffect(() => {
    if (!closeFetcher.data?.ok) return;
    window.location.assign(
      closeFetcher.data.deleted === "user"
        ? "/login?left=1"
        : "/login?closed=1",
    );
  }, [closeFetcher.data]);
  return (
    <PageShell
      className="settings-page"
      icon={<Settings aria-hidden="true" className="h-6 w-6" />}
      title="Settings"
    >
      {/* The page reads as three groups: the settings everyone in the account
          shares, the account itself (name, members and the code that adds
          them), then what belongs to the signed-in user. The rules separate
          the groups; sections inside one are spaced, not ruled. */}
      <NameList
        title="Categories"
        id="categories"
        items={categories}
        addIntent="addCategory"
        addPlaceholder="Add category"
        renderItem={(category) => (
          <CategoryRow key={category.name} category={category} />
        )}
      />

      <Section id="mileage-rates" title="Mileage rates">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          The IRS rate for a trip is picked automatically from its date and type
          (business, charity, medical, moving).{" "}
          {currentRates ? (
            <>
              <span className="font-medium text-gray-700 dark:text-gray-200">
                {currentRates.isCurrent ? "Current" : "Latest published"}:{" "}
                {MILEAGE_TYPES.map(
                  (t) =>
                    `${MILEAGE_TYPE_LABELS[t]} $${formatRate(currentRates.byType[t] ?? "")}`,
                ).join(" · ")}{" "}
                / mi
              </span>{" "}
              ({periodLabel(currentRates.startDate, currentRates.endDate)}
              ).{" "}
            </>
          ) : null}
          Updated from the{" "}
          <a
            href="https://www.irs.gov/tax-professionals/standard-mileage-rates"
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 dark:text-blue-400 hover:underline"
          >
            IRS standard mileage rates page
          </a>
          .
        </p>
      </Section>

      <Section id="start-location" title="Locations">
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          Home is where a trip starts by default, so it can't be removed. The
          other locations are places you drive to; pick one by name when you log
          a trip.
        </p>
        <LocationsList homeAddress={homeAddress} locations={locations} />
      </Section>

      <AgentsSection oauthSessions={oauthSessions} mcpUrl={mcpUrl} />

      <hr className="mb-8 border-t border-gray-200 dark:border-gray-700" />

      <Section title="Account">
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          Everyone in this account shares expenses, reports, categories, and
          settings.
        </p>
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <FieldLabel as="div" muted>
                Account name
              </FieldLabel>
              <div className="font-semibold">{accountName}</div>
            </div>
            <Form method="post" className="contents">
              <input type="hidden" name="intent" value="regenerateCode" />
              <Button type="submit" size="sm" variant="secondary">
                <RefreshCw aria-hidden="true" className="h-4 w-4" /> New code
              </Button>
            </Form>
          </div>
          <div id="invite-code" className="scroll-mt-6">
            <FieldLabel as="div" muted>
              Invite code: share to let someone join this account
            </FieldLabel>
            <div className="font-mono text-2xl font-bold tracking-widest">
              {inviteCode}
            </div>
          </div>
          <div className="mt-4 border-t border-gray-100 dark:border-gray-800 pt-3">
            <FieldLabel as="div" className="mb-1">
              Members
            </FieldLabel>
            <ul className="flex flex-col gap-1">
              {/* The current user first, then everyone else by join date. */}
              {[
                ...members.filter((m) => m.email === userEmail),
                ...members.filter((m) => m.email !== userEmail),
              ].map((member) => (
                <li
                  key={member.email}
                  className="flex items-center justify-between gap-2 rounded-lg bg-gray-50 dark:bg-gray-900 px-3 py-1.5"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-sm">
                      {member.email}
                    </span>
                    {member.email === userEmail ? (
                      <Badge tone="blue" className="shrink-0">
                        You
                      </Badge>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                      Joined <LocalDate iso={member.createdAt} />
                    </span>
                    {member.emailVerifiedAt ? (
                      <Badge
                        tone="green"
                        className="shrink-0"
                        icon={<Check aria-hidden="true" className="h-3 w-3" />}
                      >
                        Active
                      </Badge>
                    ) : (
                      <Badge tone="amber" className="shrink-0">
                        Waiting to verify
                      </Badge>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <StatusNote className="mt-2 text-xs">
              A member appears here as soon as they join with the invite code.
              "Active" means they've verified their email and can sign in;
              "Waiting to verify" means they joined but haven't clicked the
              emailed verification link yet.
            </StatusNote>
          </div>
        </Card>
      </Section>

      <hr className="mb-8 border-t border-gray-200 dark:border-gray-700" />

      <Section id="emails" title="Your email">
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          Receipts-by-email notices and security emails (sign-in verification,
          password resets) go to your sign-in email. Marketing emails (product
          news and tips) go there too, and you can turn those off below.
        </p>
        <SignInEmailForm userEmail={userEmail} />
        <Card className="flex items-center justify-between gap-4 p-4">
          <div className="min-w-0 text-sm">
            {marketingUnsubscribed ? (
              <>
                <span className="font-medium text-gray-700 dark:text-gray-200">
                  Unsubscribed
                </span>{" "}
                <span className="text-gray-500 dark:text-gray-400">
                  since <LocalDate iso={marketingUnsubscribed} />
                </span>
              </>
            ) : (
              <span className="font-medium text-gray-700 dark:text-gray-200">
                Subscribed
              </span>
            )}
          </div>
          <Form method="post" className="shrink-0">
            <input type="hidden" name="intent" value="marketingEmails" />
            <input
              type="hidden"
              name="preference"
              value={marketingUnsubscribed ? "resubscribe" : "unsubscribe"}
            />
            <Button type="submit" size="md" variant="secondary">
              {marketingUnsubscribed ? "Subscribe again" : "Unsubscribe"}
            </Button>
          </Form>
        </Card>
      </Section>

      <PasswordSection userEmail={userEmail} />

      <Section title="Session">
        <div className="flex items-center justify-between gap-4">
          <p className="min-w-0 flex-1 text-sm text-gray-500 dark:text-gray-400">
            Sign out of this device. You will need your email and password to
            get back in.
          </p>
          <Form method="post" action="/sign-out" className="shrink-0">
            <Button type="submit" size="md" variant="secondary">
              <LogOut aria-hidden="true" className="h-4 w-4" /> Sign out
            </Button>
          </Form>
        </div>
      </Section>

      <Section id="close-account" title="Close account">
        <div className="flex items-center justify-between gap-4">
          <p className="min-w-0 flex-1 text-sm text-gray-500 dark:text-gray-400">
            {closeAccountSummary(footprint)}
          </p>
          <Button
            type="button"
            size="md"
            variant="danger"
            className="shrink-0"
            onClick={() => setConfirmingClose(true)}
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" /> Close my account
          </Button>
        </div>
      </Section>

      {confirmingClose ? (
        <ConfirmDialog
          message={
            footprint.members === 1
              ? "Close your account?"
              : "Leave this account?"
          }
          confirmLabel={
            footprint.members === 1 ? "Close my account" : "Leave account"
          }
          onConfirm={() => {
            void closeFetcher.submit(
              { intent: "closeAccount", password: closePassword },
              { method: "post" },
            );
          }}
          onCancel={() => {
            setConfirmingClose(false);
            setClosePassword("");
          }}
          deleting={closeFetcher.state !== "idle"}
        >
          <p>
            {footprint.members === 1
              ? "Everything in it is deleted, now and permanently."
              : "Your login leaves; the account and its receipts stay with the others."}
          </p>
          <Field label="Password" className="mt-3">
            <Input
              type="password"
              name="password"
              autoComplete="current-password"
              value={closePassword}
              onChange={(e) => setClosePassword(e.currentTarget.value)}
              invalid={Boolean(closeFetcher.data?.error)}
            />
          </Field>
          {closeFetcher.data?.error ? (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">
              {closeFetcher.data.error}
            </p>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </PageShell>
  );
}
