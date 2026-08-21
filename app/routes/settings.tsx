import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  MapPin,
  LogOut,
  RefreshCw,
  Settings,
} from "lucide-react";
import { Form, Link, redirect } from "react-router";
import { Button } from "~/components/ui/Button";
import { Field } from "~/components/ui/Field";
import { Input } from "~/components/ui/Input";
import { AgentsSection } from "~/components/settings/agents-section";
import { EmailAccountsSection } from "~/components/settings/email-accounts";
import { CategoryRow, NameList } from "~/components/settings/name-list";
import {
  AddSenderForm,
  SenderRow,
} from "~/components/settings/receipts-by-email";
import { requireUser } from "~/lib/auth.server";
import { INBOUND_EMAIL_ADDRESS } from "~/lib/env";
import { geocode } from "~/lib/maps.server";
import { sendVerificationEmail } from "~/lib/sender-verification.server";
import {
  readAccount,
  readAccountUsers,
  regenerateInviteCode,
} from "~/lib/db/accounts";
import {
  addCategory,
  readCategories,
  removeCategory,
  renameCategory,
} from "~/lib/db/categories";
import {
  addInboundSender,
  listInboundSenders,
  removeInboundSender,
  resendInboundSenderVerification,
} from "~/lib/db/inbound";
import { disconnectOAuthClient, listUserOAuthSessions } from "~/lib/db/oauth";
import {
  createEmailConnection,
  listEmailConnections,
  readEmailConnection,
  removeEmailConnection,
} from "~/lib/db/email-connections";
import { readCategoryCounts } from "~/lib/db/reports";
import { readMileageRates } from "~/lib/db/seed";
import { readSettings, writeSettings } from "~/lib/db/settings";
import { formatShortDate, todayDate } from "~/lib/format";
import {
  MILEAGE_TYPE_LABELS,
  MILEAGE_TYPES,
  currentMileageRates,
  formatRate,
  periodLabel,
} from "~/lib/mileage-rates";
import { formString, unknownIntent } from "~/lib/validation";
import { verifyJmapToken } from "~/lib/jmap.server";
import {
  decryptSecret,
  encryptSecret,
  isTokenCryptoConfigured,
} from "~/lib/token-crypto.server";
import { destroyConnectionPushSubscription } from "~/lib/email-connection-push.server";
import type { Route } from "./+types/settings";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const account = await readAccount(user.accountId);
  const [
    categories,
    settings,
    inboundSenders,
    categoryCounts,
    oauthSessions,
    rates,
    members,
    emailConnections,
  ] = await Promise.all([
    readCategories(user.accountId),
    readSettings(user.accountId),
    listInboundSenders(user.accountId),
    readCategoryCounts(user.accountId),
    listUserOAuthSessions(user.id),
    readMileageRates(),
    readAccountUsers(user.accountId),
    listEmailConnections(user.accountId),
  ]);
  // The "current rate" line is computed CLIENT-side from the browser's
  // local today — the server runs UTC and must not guess the user's day.
  // The rates table itself is passed through (timezone-independent).
  return {
    accountName: account?.name ?? "",
    inviteCode: account?.inviteCode ?? "",
    categories: categories.map((c) => ({
      name: c.name,
      count: categoryCounts.get(c.name) ?? 0,
    })),
    homeAddress: settings.homeAddress,
    inboundSenders,
    userEmail: user.email,
    inboundAddress: INBOUND_EMAIL_ADDRESS,
    rates,
    oauthSessions,
    members,
    emailConnections,
    emailAccountsConfigured: isTokenCryptoConfigured(),
    mcpUrl: new URL("/mcp", request.url).toString(),
  };
}

export function meta(): Route.MetaDescriptors {
  return [{ title: "Settings — Expense" }];
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  const form = await request.formData();
  const intent = formString(form, "intent");

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
    case "addInboundSender": {
      const result = await addInboundSender(
        user.accountId,
        formString(form, "address"),
      );
      if (!result.ok) return Response.json(result);
      // New/updated sender → email its verification link so receipts start
      // flowing once the mailbox owner clicks it. `token: null` means the
      // address was already verified for this account — nothing to send.
      if (result.token) {
        const account = await readAccount(user.accountId);
        await sendVerificationEmail({
          to: result.address,
          token: result.token,
          origin: new URL(request.url).origin,
          accountName: account?.name ?? "",
        });
      }
      return Response.json({ ok: true, address: result.address });
    }
    case "resendInboundSenderVerification": {
      const result = await resendInboundSenderVerification(
        user.accountId,
        formString(form, "address"),
      );
      if (!result.ok) return Response.json(result);
      const account = await readAccount(user.accountId);
      await sendVerificationEmail({
        to: result.address,
        token: result.token,
        origin: new URL(request.url).origin,
        accountName: account?.name ?? "",
      });
      return Response.json({ ok: true, address: result.address });
    }
    case "removeInboundSender": {
      await removeInboundSender(user.accountId, formString(form, "address"));
      break;
    }
    case "connectEmail": {
      if (!isTokenCryptoConfigured()) {
        return Response.json(
          {
            ok: false,
            error:
              "Email account connections are not configured on this deployment.",
          },
          { status: 503 },
        );
      }
      const token = formString(form, "token").trim();
      if (!token) {
        return Response.json({
          ok: false,
          error: "Paste your API token first.",
        });
      }
      const verification = await verifyJmapToken(token);
      if (!verification.ok) {
        return Response.json({ ok: false, error: verification.message });
      }
      const result = await createEmailConnection({
        accountId: user.accountId,
        provider: "fastmail",
        emailAddress: verification.info.username,
        jmapAccountId: verification.info.mailAccountId,
        tokenEnc: encryptSecret(token),
      });
      if (!result.ok) return Response.json(result);
      console.info("[email-connections] connected", {
        accountId: user.accountId,
        address: result.connection.emailAddress,
      });
      return Response.json({
        ok: true,
        address: result.connection.emailAddress,
      });
    }
    case "disconnectEmail": {
      const id = formString(form, "id");
      const connection = await readEmailConnection(user.accountId, id);
      if (connection) {
        // Best effort: tear down the server-side push subscription with
        // the user's token. A failure (revoked token, FastMail down) still
        // disconnects — the orphaned subscription dies at expiry and its
        // pushes hit the webhook's unknown-connection path.
        try {
          const token = decryptSecret(connection.tokenEnc);
          if (connection.pushSubscriptionId) {
            await destroyConnectionPushSubscription(
              token,
              connection.pushSubscriptionId,
            );
          }
        } catch (err) {
          console.warn("[email-connections] subscription teardown failed", {
            id: connection.id,
            err,
          });
        }
      }
      const removed = await removeEmailConnection(user.accountId, id);
      console.info("[email-connections] disconnected", {
        accountId: user.accountId,
        removed,
      });
      return Response.json({ ok: true });
    }
    case "disconnectOAuthClient": {
      const clientId = formString(form, "clientId");
      if (clientId) await disconnectOAuthClient(user.id, clientId);
      return Response.json({ ok: true });
    }
    case "saveHome": {
      const settings = await readSettings(user.accountId);
      const address = formString(form, "homeAddress").trim();
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
    default:
      return unknownIntent();
  }
  return redirect("/settings");
}

export default function SettingsPage({ loaderData }: Route.ComponentProps) {
  const {
    categories,
    homeAddress,
    rates,
    accountName,
    inviteCode,
    inboundSenders,
    userEmail,
    inboundAddress,
    oauthSessions,
    members,
    emailConnections,
    emailAccountsConfigured,
    mcpUrl,
  } = loaderData;
  // The "current rate" line depends on the browser's local today (the
  // server runs UTC) — computed client-side after mount.
  const [today, setToday] = useState<string | null>(null);
  useEffect(() => {
    setToday(todayDate());
  }, []);
  const currentRates = useMemo(
    () => (today ? currentMileageRates(rates, today) : null),
    [today, rates],
  );
  return (
    <main
      id="main-content"
      className="settings-page mx-auto max-w-2xl px-4 py-8"
    >
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Settings aria-hidden="true" className="h-6 w-6" /> Settings
        </h1>
        <Button asChild variant="ghost" size="sm">
          <Link to="/">
            <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Back to
            expenses
          </Link>
        </Button>
      </header>
      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Account</h2>
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          Everyone in this account shares expenses, reports, categories, and
          settings.
        </p>
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
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
              Invite code — share to let someone join this account
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
                      <span className="shrink-0 rounded-full bg-blue-100 dark:bg-gray-700 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-400">
                        You
                      </span>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                      Joined {formatShortDate(member.createdAt)}
                    </span>
                    {member.emailVerifiedAt ? (
                      <span className="flex shrink-0 items-center gap-1 rounded-full bg-green-100 dark:bg-green-900/60 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">
                        <Check aria-hidden="true" className="h-3 w-3" /> Active
                      </span>
                    ) : (
                      <span className="shrink-0 rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                        Waiting to verify
                      </span>
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
        </div>
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
        <h2 className="mb-2 text-lg font-semibold">Start/end location</h2>
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          Used as the start and end of every mileage route — trips are always
          round trips back here.
        </p>
        <Form method="post" className="flex items-end gap-2">
          <input type="hidden" name="intent" value="saveHome" />
          <Field label="Address" className="flex-1">
            <Input type="text" name="homeAddress" defaultValue={homeAddress} />
          </Field>
          <Button type="submit" size="md">
            <MapPin aria-hidden="true" className="h-4 w-4" /> Save
          </Button>
        </Form>
      </section>

      <section id="receipts-by-email" className="mb-8 scroll-mt-6">
        <h2 className="mb-2 text-lg font-semibold">Receipts by email</h2>
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          Forward receipt emails to the address below and they are parsed
          (merchant, amount, category) and added automatically. The expense date
          is the date of the forwarded email.
        </p>
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
          {inboundAddress ? (
            <div className="mb-4">
              <div className="text-sm font-medium text-gray-500 dark:text-gray-400">
                Forward receipts to
              </div>
              <div className="font-mono text-lg font-semibold">
                {inboundAddress}
              </div>
            </div>
          ) : (
            <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
              Set the INBOUND_EMAIL_ADDRESS environment variable to show the
              forwarding address here.
            </p>
          )}
          <div className="mb-3">
            <div className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-200">
              Sender addresses
            </div>
            <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
              Receipts are imported only from <b>verified</b> addresses. Adding
              an address sends a verification link to that inbox. Once the link
              is clicked, the address is locked to your account — no one else
              can claim it — and receipts start importing.
            </p>
            <ul className="flex flex-col gap-1">
              {inboundSenders.length === 0 ? (
                <li className="text-sm text-gray-500 dark:text-gray-400">
                  None yet.
                </li>
              ) : (
                inboundSenders.map((sender) => (
                  <SenderRow
                    key={sender.address}
                    sender={sender}
                    isDefault={sender.address === userEmail}
                  />
                ))
              )}
            </ul>
          </div>
          <AddSenderForm />
        </div>
      </section>

      <EmailAccountsSection
        connections={emailConnections}
        configured={emailAccountsConfigured}
      />

      <AgentsSection oauthSessions={oauthSessions} mcpUrl={mcpUrl} />

      <section className="border-t border-gray-100 dark:border-gray-800 pt-6">
        <h2 className="mb-2 text-lg font-semibold">Session</h2>
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Sign out of this device. You will need your email and password to
            get back in.
          </p>
          <Form method="post" action="/sign-out">
            <Button type="submit" size="md" variant="secondary">
              <LogOut aria-hidden="true" className="h-4 w-4" /> Sign out
            </Button>
          </Form>
        </div>
      </section>
    </main>
  );
}
