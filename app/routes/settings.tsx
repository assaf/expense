import { useMemo } from "react";
import { Check, LogOut, RefreshCw, Settings } from "lucide-react";
import { Form, redirect } from "react-router";
import { Button } from "~/components/ui/Button";
import { Badge } from "~/components/ui/Badge";
import { Card } from "~/components/ui/Card";
import { PageShell } from "~/components/PageShell";
import { AgentsSection } from "~/components/settings/agents-section";
import { CategoryRow, NameList } from "~/components/settings/name-list";
import { LocationsList } from "~/components/settings/locations-list";
import { requireUser } from "~/lib/auth.server";
import { requireIntent } from "~/lib/route-helpers.server";
import { geocode } from "~/lib/maps.server";
import {
  readAccount,
  readAccountUsers,
  regenerateInviteCode,
  readMarketingUnsubscribed,
  resubscribeMarketingEmail,
  unsubscribeMarketingEmail,
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
  ] = await Promise.all([
    readCategories(user.accountId),
    readSettings(user.accountId),
    readCategoryCounts(user.accountId),
    listUserOAuthSessions(user.id),
    readMileageRates(),
    readAccountUsers(user.accountId),
    readLocations(user.accountId),
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
    userEmail: user.email,
    marketingUnsubscribed: await readMarketingUnsubscribed(user.id),
    rates,
    oauthSessions,
    members,
    mcpUrl: new URL("/mcp", request.url).toString(),
  };
}

export function meta(): Route.MetaDescriptors {
  return [{ title: "Settings — Expense" }];
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
  } = loaderData;
  // The "current rate" line depends on the browser's local today (the
  // server runs UTC); computed client-side after mount.
  const today = useToday();
  const currentRates = useMemo(
    () => (today ? currentMileageRates(rates, today) : null),
    [today, rates],
  );
  return (
    <PageShell
      className="settings-page"
      icon={<Settings aria-hidden="true" className="h-6 w-6" />}
      title="Settings"
    >
      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Account</h2>
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          Everyone in this account shares expenses, reports, categories, and
          settings.
        </p>
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-gray-500 dark:text-gray-400">
                Account name
              </div>
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
            <div className="text-sm font-medium text-gray-500 dark:text-gray-400">
              Invite code: share to let someone join this account
            </div>
            <div className="font-mono text-2xl font-bold tracking-widest">
              {inviteCode}
            </div>
          </div>
          <div className="mt-4 border-t border-gray-100 dark:border-gray-800 pt-3">
            <div className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-200">
              Members
            </div>
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
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              A member appears here as soon as they join with the invite code.
              "Active" means they've verified their email and can sign in;
              "Waiting to verify" means they joined but haven't clicked the
              emailed verification link yet.
            </p>
          </div>
        </Card>
      </section>

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

      <section id="mileage-rates" className="mb-8 scroll-mt-6">
        <h2 className="mb-2 text-lg font-semibold">Mileage rates</h2>
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
      </section>

      <section id="start-location" className="mb-8 scroll-mt-6">
        <h2 className="mb-2 text-lg font-semibold">Locations</h2>
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          Home is where a trip starts by default, so it can't be removed. The
          other locations are places you drive to; pick one by name when you log
          a trip.
        </p>
        <LocationsList homeAddress={homeAddress} locations={locations} />
      </section>

      <section id="emails" className="mb-8 scroll-mt-6">
        <h2 className="mb-2 text-lg font-semibold">Emails</h2>
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          Marketing emails (product news and tips) go to{" "}
          <span className="font-medium text-gray-700 dark:text-gray-200">
            {userEmail}
          </span>
          . Receipts-by-email notices and security emails (sign-in verification,
          password resets) are always sent.
        </p>
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
      </section>

      <AgentsSection oauthSessions={oauthSessions} mcpUrl={mcpUrl} />

      <section className="border-t border-gray-100 dark:border-gray-800 pt-6">
        <h2 className="mb-2 text-lg font-semibold">Session</h2>
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
      </section>
    </PageShell>
  );
}
