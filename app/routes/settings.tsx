import {
  ArrowLeft,
  Check,
  Plus,
  Trash2,
  Pencil,
  MapPin,
  LogOut,
  RefreshCw,
  Settings,
  KeyRound,
} from "lucide-react";
import { forwardRef, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Form, Link, useFetcher } from "react-router";
import { redirect } from "react-router";
import { Button } from "~/components/ui/Button";
import { Field } from "~/components/ui/Field";
import { Input } from "~/components/ui/Input";
import { requireUser } from "~/lib/auth.server";
import { INBOUND_EMAIL_ADDRESS } from "~/lib/env";
import { geocode } from "~/lib/maps.server";
import { sendVerificationEmail } from "~/lib/sender-verification.server";
import { readSettings, writeSettings } from "~/lib/settings.server";
import {
  addCategory,
  addInboundSender,
  disconnectOAuthClient,
  listInboundSenders,
  listUserOAuthSessions,
  readAccount,
  readAccountUsers,
  readCategories,
  readCategoryCounts,
  readMileageRates,
  regenerateInviteCode,
  removeCategory,
  removeInboundSender,
  renameCategory,
  resendInboundSenderVerification,
} from "~/lib/store.server";
import { countLabel, formatShortDate, todayDate } from "~/lib/format";
import type { InboundSenderRecord } from "~/lib/types";
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
    inboundSenders,
    categoryCounts,
    oauthSessions,
    rates,
    members,
  ] = await Promise.all([
    readCategories(user.accountId),
    readSettings(user.accountId),
    listInboundSenders(user.accountId),
    readCategoryCounts(user.accountId),
    listUserOAuthSessions(user.id),
    readMileageRates(),
    readAccountUsers(user.accountId),
  ]);
  // A compact "current rate" line for Settings — the editor itself resolves
  // the exact rate per trip (date + type), so the page only needs today's.
  const currentRates = currentMileageRates(rates, todayDate());
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
    currentRates,
    oauthSessions,
    members,
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
    currentRates,
    accountName,
    inviteCode,
    inboundSenders,
    userEmail,
    inboundAddress,
    oauthSessions,
    members,
    mcpUrl,
  } = loaderData;
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

/**
 * One receipts-by-email sender: the address, its verified status, and
 * actions. The account's login email (the default sender) is locked — it
 * can't be removed, only verified. Unverified addresses get a Resend button
 * that emails a fresh verification link.
 */
function SenderRow({
  sender,
  isDefault,
}: {
  sender: InboundSenderRecord;
  isDefault: boolean;
}) {
  const resendFetcher = useFetcher<{ ok: boolean; error?: string }>();
  const removeFetcher = useFetcher();
  return (
    <li className="flex flex-col gap-1 rounded-lg bg-gray-50 dark:bg-gray-900 px-3 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-sm">{sender.address}</span>
          {isDefault ? (
            <span className="shrink-0 rounded-full bg-blue-100 dark:bg-gray-700 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-400">
              Your sign-in email
            </span>
          ) : null}
          {sender.verified ? (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-green-100 dark:bg-green-900/60 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">
              <Check aria-hidden="true" className="h-3 w-3" /> Verified
            </span>
          ) : (
            <span className="shrink-0 rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
              Awaiting verification
            </span>
          )}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {!sender.verified ? (
            <resendFetcher.Form method="post" className="contents">
              <input
                type="hidden"
                name="intent"
                value="resendInboundSenderVerification"
              />
              <input type="hidden" name="address" value={sender.address} />
              <button
                type="submit"
                className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                aria-label={`Resend verification email to ${sender.address}`}
              >
                Resend email
              </button>
            </resendFetcher.Form>
          ) : null}
          {!isDefault ? (
            <removeFetcher.Form method="post" className="contents">
              <input type="hidden" name="intent" value="removeInboundSender" />
              <input type="hidden" name="address" value={sender.address} />
              <button
                type="submit"
                className="text-gray-500 dark:text-gray-400 hover:text-red-600 dark:text-red-400"
                aria-label={`Remove ${sender.address}`}
              >
                <Trash2 aria-hidden="true" className="h-4 w-4" />
              </button>
            </removeFetcher.Form>
          ) : null}
        </div>
      </div>
      {resendFetcher.state !== "idle" ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Sending verification email…
        </p>
      ) : resendFetcher.data?.ok ? (
        <p className="text-xs text-green-700 dark:text-green-400">
          Verification email sent — check that inbox and click the link.
        </p>
      ) : resendFetcher.data?.error ? (
        <p className="text-xs text-red-600 dark:text-red-400">
          {resendFetcher.data.error}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Add a new receipts-by-email sender. Adding an address only accepts
 * receipts after its mailbox owner clicks the emailed verification link, so
 * the form reports whether the verification email went out (or why not).
 */
function AddSenderForm() {
  const fetcher = useFetcher<{
    ok: boolean;
    error?: string;
    address?: string;
  }>();
  const [address, setAddress] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const busy = fetcher.state !== "idle";

  // A successful add leaves the row in the list with its own status — clear
  // the input; the notice carries the "email sent" confirmation.
  useEffect(() => {
    const data = fetcher.data;
    if (!data) return;
    if (data.ok && data.address) {
      setAddress("");
      setNotice({
        ok: true,
        text: `Verification email sent to ${data.address} — click the link in it and receipts from this address will start importing.`,
      });
    } else if (data.error) {
      setNotice({ ok: false, text: data.error });
    }
  }, [fetcher.data]);

  return (
    <div>
      <fetcher.Form method="post" className="flex items-center gap-2">
        <input type="hidden" name="intent" value="addInboundSender" />
        <Input
          type="email"
          name="address"
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            setNotice(null);
          }}
          placeholder="you@example.com"
          required
          aria-invalid={notice && !notice.ok ? true : undefined}
          invalid={!!notice && !notice.ok}
          className="flex-1"
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={busy || !address.trim()}
        >
          <Plus aria-hidden="true" className="h-4 w-4" />{" "}
          {busy ? "Adding…" : "Add address"}
        </Button>
      </fetcher.Form>
      {notice ? (
        <p
          role="status"
          className={`mt-1 text-xs ${notice.ok ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
        >
          {notice.text}
        </p>
      ) : (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          A verification email is sent to the address before receipts are
          accepted.
        </p>
      )}
    </div>
  );
}

/**
 * Agents & API (MCP): the OAuth-connected apps for this account. Each app
 * shows its name, client id, when it was last used, and when its access
 * expires; the remove button revokes every token for the app and drops the
 * consent. (Tokens are managed as a whole per app — no individual rows.)
 */
function AgentsSection({
  oauthSessions,
  mcpUrl,
}: {
  oauthSessions: {
    client: { id: string; name: string };
    lastUsedAt: string | null;
    expiresAt: string | null;
  }[];
  mcpUrl: string;
}) {
  const removeFetcher = useFetcher<{ ok: boolean }>();

  return (
    <section id="agents" className="mb-8 scroll-mt-6">
      <h2 className="mb-2 text-lg font-semibold">Agents &amp; API (MCP)</h2>
      <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
        Connect your AI assistant — Claude, OpenAI, or any MCP client — to this
        account. Point the client at the endpoint below and approve the
        connection in your browser by signing in. Agents can capture receipts,
        log mileage, answer “how much did I spend on …?”, build and export
        reports, and reconcile bank statements against logged expenses.
      </p>
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
        <div className="mb-4">
          <div className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-200">
            Endpoint
          </div>
          <div className="font-mono text-sm text-gray-600 dark:text-gray-300">
            {mcpUrl}
          </div>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Point your MCP client here — it discovers the sign-in flow
            automatically.
          </p>
        </div>

        <div>
          <div className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-200">
            Connected apps
          </div>
          {oauthSessions.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              None yet. The first time an assistant connects, you approve it
              here by signing in.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {oauthSessions.map(({ client, lastUsedAt, expiresAt }) => (
                <li
                  key={client.id}
                  className="rounded-lg bg-gray-50 dark:bg-gray-900 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <KeyRound
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400"
                      />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {client.name}
                        </div>
                        <div className="truncate font-mono text-xs text-gray-500 dark:text-gray-400">
                          {client.id}
                        </div>
                      </div>
                    </div>
                    <removeFetcher.Form method="post" className="contents">
                      <input
                        type="hidden"
                        name="intent"
                        value="disconnectOAuthClient"
                      />
                      <input type="hidden" name="clientId" value={client.id} />
                      <button
                        type="submit"
                        className="shrink-0 text-gray-500 dark:text-gray-400 hover:text-red-600 dark:text-red-400"
                        aria-label={`Remove ${client.name}`}
                        title={`Remove ${client.name}`}
                      >
                        <Trash2 aria-hidden="true" className="h-4 w-4" />
                      </button>
                    </removeFetcher.Form>
                  </div>
                  <p className="mt-1 border-t border-gray-200 dark:border-gray-700 pl-8 pt-1.5 text-xs text-gray-500 dark:text-gray-400">
                    {expiresAt
                      ? `Last used ${formatShortDate(lastUsedAt)} · expires ${formatShortDate(expiresAt)}`
                      : `Last used ${formatShortDate(lastUsedAt)} · no active tokens`}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            Removing an app revokes its access tokens immediately and stops it
            from connecting again; it can reconnect by signing in again.
          </p>
        </div>
      </div>
    </section>
  );
}

function NameList<T extends { name: string }>({
  title,
  id,
  items,
  addIntent,
  addPlaceholder,
  renderItem,
}: {
  title: string;
  /** Anchor target for in-page links (e.g. /settings#reports). */
  id?: string;
  items: readonly T[];
  addIntent: string;
  addPlaceholder: string;
  /** Full row content for every item in the list. */
  renderItem: (item: T) => ReactNode;
}) {
  const fetcher = useFetcher<{ ok: boolean; name?: string; error?: string }>();
  const [flashName, setFlashName] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const flashRef = useRef<HTMLLIElement | null>(null);

  // A new entry landed (fetcher, no page navigation): flash it and clear
  // the add input. A rejected add (duplicate) shows its error inline. The
  // loader revalidation has already added the row by the time this runs,
  // so the flash ref is available on the next render.
  useEffect(() => {
    const { data } = fetcher;
    if (!data) return;
    if (data.ok && data.name) {
      setFlashName(data.name);
      setError(null);
      setDraft("");
    } else if (data.error) {
      setError(data.error);
    }
  }, [fetcher.data]);

  // Time-box the flash and bring the new row into view.
  useEffect(() => {
    if (!flashName) return;
    flashRef.current?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
    const timer = setTimeout(() => setFlashName(null), 3000);
    return () => clearTimeout(timer);
  }, [flashName]);

  const [announcement, setAnnouncement] = useState<string | null>(null);
  useEffect(() => {
    if (flashName) setAnnouncement(`Added ${flashName}`);
    else setAnnouncement(null);
  }, [flashName]);

  return (
    <section id={id} className="mb-8 scroll-mt-6">
      <h2 className="mb-2 text-lg font-semibold">{title}</h2>
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      <ul className="mb-3 flex flex-col gap-1">
        {items.length === 0 ? (
          <li className="text-sm text-gray-500 dark:text-gray-400">
            None yet.
          </li>
        ) : (
          items.map((item) => (
            <li
              key={item.name}
              ref={item.name === flashName ? flashRef : undefined}
              className={`flex items-center justify-between gap-2 rounded-lg px-3 py-1.5 transition-colors duration-500 ${
                item.name === flashName
                  ? "bg-amber-200 dark:bg-amber-800"
                  : "bg-gray-50 dark:bg-gray-900"
              }`}
            >
              {renderItem(item)}
            </li>
          ))
        )}
      </ul>
      <fetcher.Form method="post" className="flex items-center gap-2">
        <input type="hidden" name="intent" value={addIntent} />
        <Input
          type="text"
          name="name"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          placeholder={addPlaceholder}
          aria-invalid={error ? true : undefined}
          invalid={!!error}
          className="flex-1"
        />
        <Button
          type="submit"
          size="md"
          variant="secondary"
          disabled={!draft.trim()}
        >
          <Plus aria-hidden="true" className="h-4 w-4" /> Add
        </Button>
      </fetcher.Form>
      {error ? (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : null}
    </section>
  );
}

/**
 * One category row in Settings: name + the number of expenses in reports
 * that are not closed, and a delete button. Deleting a category used by
 * more than one such expense asks for confirmation first.
 */
type CategoryItem = { name: string; count: number };

/**
 * Inline rename editor: an input pre-filled with the current name, Save,
 * and Cancel. Submits through a fetcher (no page navigation — the page
 * stays put, and the action's error, e.g. a duplicate name, is shown
 * inline). The row that hosts it is keyed by name, so a successful rename
 * remounts the row and closes the editor.
 */
type RenameResult = { ok: boolean; error?: string };

function RenameForm({
  intent,
  name,
  onCancel,
}: {
  intent: string;
  /** Current name — also the hidden `name` field the action matches on. */
  name: string;
  onCancel: () => void;
}) {
  const fetcher = useFetcher<RenameResult>();
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (fetcher.data?.error) setError(fetcher.data.error);
    else if (fetcher.data?.ok) setError(null);
  }, [fetcher.data]);

  return (
    <div className="flex w-full flex-col gap-1">
      <fetcher.Form method="post" className="flex w-full items-center gap-2">
        <input type="hidden" name="intent" value={intent} />
        <input type="hidden" name="name" value={name} />
        <Input
          type="text"
          name="newName"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
          }}
          autoFocus
          aria-invalid={error ? true : undefined}
          invalid={!!error}
          className="min-w-0 flex-1 px-2 py-1"
        />
        <Button
          type="submit"
          size="sm"
          disabled={!draft.trim() || draft === name}
        >
          Save
        </Button>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 text-sm text-gray-500 dark:text-gray-400 hover:text-ink"
        >
          Cancel
        </button>
      </fetcher.Form>
      {error ? (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : null}
    </div>
  );
}

const RenameButton = forwardRef<
  HTMLButtonElement,
  { onClick: () => void; name: string }
>(function RenameButton({ onClick, name }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className="text-gray-500 dark:text-gray-400 hover:text-ink"
      aria-label={`Rename ${name}`}
    >
      <Pencil aria-hidden="true" className="h-4 w-4" />
    </button>
  );
});

/**
 * The trash button for a named row (category/report): hidden intent/name
 * inputs inside the row's own fetcher form, with an optional confirm
 * prompt before submitting.
 */
function RemoveButton({
  fetcher,
  intent,
  name,
  confirm,
}: {
  fetcher: ReturnType<typeof useFetcher>;
  intent: string;
  name: string;
  /** When set, asks for confirmation with this message before deleting. */
  confirm?: string;
}) {
  return (
    <fetcher.Form
      method="post"
      className="contents"
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="name" value={name} />
      <button
        type="submit"
        className="text-gray-500 dark:text-gray-400 hover:text-red-600 dark:text-red-400"
        aria-label={`Remove ${name}`}
      >
        <Trash2 aria-hidden="true" className="h-4 w-4" />
      </button>
    </fetcher.Form>
  );
}

function CategoryRow({ category }: { category: CategoryItem }) {
  const [editing, setEditing] = useState(false);
  const renameRef = useRef<HTMLButtonElement>(null);
  const removeFetcher = useFetcher();
  const confirmRemove =
    category.count > 1
      ? `This category contains ${category.count} expenses in open reports. Delete it anyway?`
      : undefined;
  useEffect(() => {
    if (!editing) renameRef.current?.focus();
  }, [editing]);
  if (editing) {
    return (
      <RenameForm
        intent="renameCategory"
        name={category.name}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <>
      <span className="truncate">{category.name}</span>
      <div className="flex shrink-0 items-center gap-2">
        <span
          className="text-xs text-gray-500 dark:text-gray-400"
          title="Expenses in reports that are not closed"
        >
          {category.count === 0 ? "No expenses" : countLabel(category.count)}
        </span>
        <RenameButton
          ref={renameRef}
          onClick={() => setEditing(true)}
          name={category.name}
        />
        <RemoveButton
          fetcher={removeFetcher}
          intent="removeCategory"
          name={category.name}
          confirm={confirmRemove}
        />
      </div>
    </>
  );
}
