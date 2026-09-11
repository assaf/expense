import { describe, expect, it, vi } from "vitest";
import { action } from "~/routes/settings";
import { sessionStorage, SESSION_USER_KEY } from "~/lib/auth.server";
import { readLocations, removeLocation } from "~/lib/db/locations";
import { geocode } from "~/lib/maps.server";
import { TEST_ACCOUNT_ID } from "./helpers/seedTestData";
import type { Route as SettingsRoute } from "+types/app/routes/+types/settings";

/**
 * The Settings page's named-location writes, driven through the route action
 * (the browser path is covered in test/settings.test.ts). The geocoder is
 * mocked: the suite never makes a live map call, and what matters here is
 * that a saved row carries the coordinates the app resolved for its address.
 */
vi.mock("~/lib/maps.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  geocode: vi.fn(async (address: string) => ({
    address,
    lat: 34.1,
    lng: -118.2,
  })),
}));

async function post(form: FormData): Promise<Response> {
  const session = await sessionStorage.getSession();
  session.set(SESSION_USER_KEY, "user_test1");
  const cookie = await sessionStorage.commitSession(session);
  return action({
    request: new Request("https://expense.test/settings", {
      method: "POST",
      body: form,
      headers: { cookie },
    }),
    params: {},
    context: {},
  } as SettingsRoute.ActionArgs);
}

function addForm(name: string, address: string): FormData {
  const form = new FormData();
  form.set("intent", "addLocation");
  form.set("name", name);
  form.set("address", address);
  return form;
}

describe("settings locations", () => {
  it("saves a new location with the geocoded coordinates", async () => {
    const res = await post(addForm("Clinic", "1 Care Way, Testing, CA"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body).toMatchObject({ ok: true, geocoded: true, name: "Clinic" });
    expect(vi.mocked(geocode)).toHaveBeenCalledWith("1 Care Way, Testing, CA");

    const saved = (await readLocations(TEST_ACCOUNT_ID)).find(
      (l) => l.id === body.id,
    );
    expect(saved).toMatchObject({
      name: "Clinic",
      address: "1 Care Way, Testing, CA",
      lat: 34.1,
      lng: -118.2,
    });

    await removeLocation(TEST_ACCOUNT_ID, body.id);
  });

  it("reports a duplicate name without writing a row", async () => {
    const res = await post(addForm("Work", "9 Dupe St, Testing, CA"));
    expect(await res.json()).toMatchObject({
      ok: false,
      error: 'A location named "Work" already exists.',
    });
    expect(
      (await readLocations(TEST_ACCOUNT_ID)).filter((l) => l.name === "Work"),
    ).toHaveLength(1);
  });

  it("renames and re-addresses an existing location", async () => {
    const created = (await (
      await post(addForm("Gym", "2 Lift Rd, Testing, CA"))
    ).json()) as { id: string };
    const form = new FormData();
    form.set("intent", "updateLocation");
    form.set("id", created.id);
    form.set("name", "Studio");
    form.set("address", "3 Lift Rd, Testing, CA");
    expect(await (await post(form)).json()).toMatchObject({
      ok: true,
      id: created.id,
      name: "Studio",
    });

    expect(
      (await readLocations(TEST_ACCOUNT_ID)).find((l) => l.id === created.id),
    ).toMatchObject({ name: "Studio", address: "3 Lift Rd, Testing, CA" });

    await removeLocation(TEST_ACCOUNT_ID, created.id);
  });

  it("deletes a location and returns to the page", async () => {
    const created = (await (
      await post(addForm("Storage", "4 Box Ln, Testing, CA"))
    ).json()) as { id: string };
    const form = new FormData();
    form.set("intent", "removeLocation");
    form.set("id", created.id);
    const res = await post(form);
    // The row buttons post through a fetcher; a delete reloads the page so
    // the list can only ever show what the loader read.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/settings");
    expect(
      (await readLocations(TEST_ACCOUNT_ID)).some((l) => l.id === created.id),
    ).toBe(false);
  });
});
