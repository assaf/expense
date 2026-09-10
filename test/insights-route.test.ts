import { beforeEach, describe, expect, it, vi } from "vitest";
import { action, loader } from "~/routes/insights";
import { insightProfile, insightReportNames } from "~/lib/insights-ai.server";
import { sessionStorage, SESSION_USER_KEY } from "~/lib/auth.server";
import { chatCompletion } from "~/lib/receipt-ai.server";
import { testPrisma, TEST_ACCOUNT_ID } from "./helpers/seedTestData";
import { addReport } from "~/lib/db/reports";
import type { Route as InsightsRoute } from "+types/app/routes/+types/insights";

// The translator boundary is what the route adds on top of the pure lib
// (covered in test/insights.test.ts): the LLM is reached exactly once for
// a translation, and the text answer is grounded in computed numbers.
vi.mock("~/lib/receipt-ai.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chatCompletion: vi.fn(),
}));

const chat = vi.mocked(chatCompletion);

async function callRoute(
  kind: "loader" | "action",
  plan: string | null,
  formData?: FormData,
) {
  await testPrisma.account.update({
    where: { id: TEST_ACCOUNT_ID },
    data: { plan },
  });
  const session = await sessionStorage.getSession();
  session.set(SESSION_USER_KEY, "user_test1");
  const cookie = await sessionStorage.commitSession(session);
  const request = new Request("https://expense.test/insights", {
    method: kind === "action" ? "POST" : "GET",
    ...(formData
      ? { body: formData, method: "POST" as const, headers: { cookie } }
      : { headers: { cookie } }),
  });
  if (kind === "loader") {
    return loader({
      request,
      params: {},
      context: {},
    } as InsightsRoute.LoaderArgs);
  }
  return action({
    request,
    params: {},
    context: {},
  } as InsightsRoute.ActionArgs);
}

describe("insights route", () => {
  beforeEach(async () => {
    chat.mockReset();
    await testPrisma.account.update({
      where: { id: TEST_ACCOUNT_ID },
      data: { plan: null },
    });
  });

  it("translates without a plan, reaching the LLM once", async () => {
    chat.mockResolvedValue('{"query":"","title":"Expenses","months":12}');
    const form = new FormData();
    form.set("intent", "translate");
    form.set("text", "everything");
    const res = (await callRoute("action", null, form)) as {
      ok: boolean;
      answer: string;
    };
    expect(res.ok).toBe(true);
    // No client today -> chart-only answer, no second call.
    expect(chat).toHaveBeenCalledTimes(1);
    expect(res.answer).toContain("Charting");
  });

  it("grounds the text answer in computed numbers for a plan account", async () => {
    // Call 1: the question is text-shaped (chart:false). Call 2 phrases
    // the answer from the computed data.
    chat
      .mockResolvedValueOnce(
        '{"query":"","title":"Expenses","months":12,"chart":false}',
      )
      .mockResolvedValueOnce("You spent $99.99 at DevShop in April.");
    // Give one report a creation date; the profile context must carry it.
    await testPrisma.report.update({
      where: {
        reports_accountId_name_key: {
          accountId: TEST_ACCOUNT_ID,
          name: "2026 Test",
        },
      },
      data: { createdAt: new Date("2026-01-05T09:30:00Z") },
    });
    const form = new FormData();
    form.set("intent", "translate");
    form.set("text", "all reports and when they were created");
    form.set("today", "2026-07-15");
    form.set("localTime", "1:15 PM");
    form.set("tz", "UTC");
    // Fresh report rows with creation stamps (addReport busts the cache).
    await testPrisma.report.deleteMany({});
    await addReport(TEST_ACCOUNT_ID, "2026 Test");
    await addReport(TEST_ACCOUNT_ID, "2027 Test");
    const res = (await callRoute("action", "gratis", form)) as {
      ok: boolean;
      chart: boolean;
      answer: string;
    };
    expect(res.ok).toBe(true);
    expect(res.chart).toBe(false);
    expect(res.answer).toContain("$99.99");
    expect(chat).toHaveBeenCalledTimes(2);
    // The answer prompt carries the computed data, not the raw question.
    const answerCall = chat.mock.calls[1]![0];
    const userMessage = answerCall[answerCall.length - 1]!.content;
    expect(userMessage).toContain("Computed data:");
    expect(userMessage).toContain("DevShop");
    expect(userMessage).toContain(
      "Question: all reports and when they were created",
    );
    // Profile context rides along: account name, member email, categories.
    expect(userMessage).toContain("About the user:");
    expect(userMessage).toContain("Test Account");
    expect(userMessage).toContain("testuser@example.com");
    expect(userMessage).toContain("Current time: ");
    // The dated report carries its creation timestamp; the undated one
    // appears bare.
    // The stored timestamp is TZ-shifted by the driver; assert the date
    // and the annotation shape, not the wall-clock time.
    expect(userMessage).toMatch(
      /2026 Test \(created \w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M\)/,
    );
    expect(userMessage).toContain("Reports: 2026 Test (created");
  });
});

describe("insightProfile", () => {
  const base = {
    account: { name: "Arkin Household" },
    settings: { homeAddress: "123 Main St" },
    userEmail: "assaf@arkin.me",
    members: [{ email: "assaf@arkin.me" }, { email: "partner@arkin.me" }],
    categories: [{ name: "Software" }, { name: "" }, { name: "Meals" }],
    reports: [
      { name: "2026 Test", createdAt: new Date("2026-09-09T20:30:00Z") },
      { name: "Legacy", createdAt: null },
    ],
    tz: "America/Los_Angeles",
  };

  it("builds the context block with emails, categories, and tz-stamped reports", () => {
    const profile = insightProfile(base);
    expect(profile).toContain("Name (account): Arkin Household");
    expect(profile).toContain("Home location: 123 Main St");
    expect(profile).toContain(
      "Email addresses: assaf@arkin.me, partner@arkin.me",
    );
    expect(profile).toContain("Categories: Software, , Meals");
    expect(profile).toMatch(/Reports: 2026 Test \(created Sep 9, 2026/);
    expect(profile).toContain("Legacy");
  });

  it("drops lines with nothing to say", () => {
    const profile = insightProfile({
      account: undefined,
      settings: { homeAddress: "" },
      userEmail: "solo@x.me",
      members: [],
      categories: [],
      reports: [],
      tz: "UTC",
    });
    expect(profile).not.toContain("Name (account)");
    expect(profile).not.toContain("Home location");
    expect(profile).toContain("Email addresses: solo@x.me");
    expect(profile).not.toContain("Categories:");
    expect(profile).not.toContain("Reports:");
  });

  it("falls back to UTC for an invalid zone", () => {
    const names = insightReportNames(
      [{ name: "R", createdAt: "2026-01-05T12:00:00Z" }],
      "Not/AZone",
    );
    expect(names[0]).toContain("Jan 5, 2026");
  });
});
