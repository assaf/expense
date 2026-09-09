import { beforeEach, describe, expect, it, vi } from "vitest";
import { action, loader } from "~/routes/insights";
import { sessionStorage, SESSION_USER_KEY } from "~/lib/auth.server";
import { chatCompletion } from "~/lib/receipt-ai.server";
import { testPrisma, TEST_ACCOUNT_ID } from "./helpers/seedTestData";
import type { Route as InsightsRoute } from "+types/app/routes/+types/insights";

// The gate and the translator boundary are what the route adds on top of
// the pure lib (covered in test/insights.test.ts): the LLM must never be
// reached without a plan, and must be reached exactly once with one.
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

describe("insights route plan gate", () => {
  beforeEach(async () => {
    chat.mockReset();
    await testPrisma.account.update({
      where: { id: TEST_ACCOUNT_ID },
      data: { plan: null },
    });
  });

  it("hides the AI box from the loader for plan-less accounts", async () => {
    const data = (await callRoute("loader", null)) as { aiEnabled: boolean };
    expect(data.aiEnabled).toBe(false);
  });

  it("enables the AI box for gratis and paid accounts", async () => {
    for (const plan of ["gratis", "paid"]) {
      const data = (await callRoute("loader", plan)) as { aiEnabled: boolean };
      expect(data.aiEnabled).toBe(true);
    }
  });

  it("rejects the translate action without a plan and never calls the LLM", async () => {
    const form = new FormData();
    form.set("intent", "translate");
    form.set("text", "my AI expenses");
    const res = (await callRoute("action", null, form)) as {
      ok: boolean;
      error: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("paid or gratis");
    expect(chat).not.toHaveBeenCalled();
  });

  it("translates for a plan account, reaching the LLM once", async () => {
    chat.mockResolvedValue('{"query":"","title":"Expenses","months":12}');
    const form = new FormData();
    form.set("intent", "translate");
    form.set("text", "everything");
    const res = (await callRoute("action", "gratis", form)) as {
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
    const form = new FormData();
    form.set("intent", "translate");
    form.set("text", "what did I spend the most on?");
    form.set("today", "2026-07-15");
    form.set("localTime", "14:32");
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
    expect(userMessage).toContain("Question: what did I spend the most on?");
    // Profile context rides along: account name, member email, categories.
    expect(userMessage).toContain("About the user:");
    expect(userMessage).toContain("Test Account");
    expect(userMessage).toContain("testuser@example.com");
    expect(userMessage).toContain("Current time: 14:32");
  });
});
