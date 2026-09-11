import { describe, expect, it } from "vitest";
import {
  addLocation,
  readLocations,
  removeLocation,
  updateLocation,
} from "~/lib/db/locations";
import { OTHER_ACCOUNT_ID, TEST_ACCOUNT_ID } from "./helpers/seedTestData";

/**
 * The account's named places: what a trip is authored from by name, and what
 * the insights chat resolves "work" or "the hospital" to. Home is not a row
 * here (it is the settings start/end location, which cannot be deleted), so
 * these tests cover the named list: ordering, account scoping, and the
 * guards that keep two places from answering to one name.
 */
describe("named locations", () => {
  it("reads the account's locations, alphabetically and scoped", async () => {
    const mine = await readLocations(TEST_ACCOUNT_ID);
    expect(mine.map((l) => l.name)).toEqual(["Hospital", "Work"]);
    expect(mine[1]).toMatchObject({
      address: "456 Dev Ave, Coding, CA",
      lat: 34.0622,
      lng: -118.2537,
    });

    // The other account's "Work" is a different place that happens to share
    // the name; neither read ever sees the other's rows.
    const other = await readLocations(OTHER_ACCOUNT_ID);
    expect(other).toHaveLength(1);
    expect(other[0]).toMatchObject({
      name: "Work",
      address: "1 Other Way, Elsewhere, CA",
    });
  });

  it("adds a location and returns the saved row", async () => {
    const result = await addLocation(TEST_ACCOUNT_ID, {
      name: "Restaurant",
      address: "12 Dine St, Testing, CA",
      lat: 34.05,
      lng: -118.25,
    });
    expect(result.ok).toBe(true);
    const saved = result.ok ? result.location : null;
    expect(saved).toMatchObject({
      name: "Restaurant",
      address: "12 Dine St, Testing, CA",
      lat: 34.05,
      lng: -118.25,
    });
    expect(saved!.id).toBeTruthy();

    const names = (await readLocations(TEST_ACCOUNT_ID)).map((l) => l.name);
    expect(names).toContain("Restaurant");
    await removeLocation(TEST_ACCOUNT_ID, saved!.id);
  });

  it("refuses a name that is empty, taken, or reserved for home", async () => {
    const address = "1 Anywhere, Testing, CA";
    const blank = { lat: null, lng: null };
    expect(
      await addLocation(TEST_ACCOUNT_ID, { name: "   ", address, ...blank }),
    ).toMatchObject({ ok: false, error: "Name can't be empty." });
    // Case and surrounding space do not make it a different place.
    expect(
      await addLocation(TEST_ACCOUNT_ID, { name: " work ", address, ...blank }),
    ).toMatchObject({
      ok: false,
      error: 'A location named "work" already exists.',
    });
    expect(
      await addLocation(TEST_ACCOUNT_ID, { name: "home", address, ...blank }),
    ).toMatchObject({ ok: false });
    expect(
      await addLocation(TEST_ACCOUNT_ID, {
        name: "Nowhere",
        address: "  ",
        ...blank,
      }),
    ).toMatchObject({ ok: false, error: "Address can't be empty." });

    // Nothing was written by any of the rejections.
    expect((await readLocations(TEST_ACCOUNT_ID)).map((l) => l.name)).toEqual([
      "Hospital",
      "Work",
    ]);
  });

  it("renames and re-addresses a location, keeping its id", async () => {
    const added = await addLocation(TEST_ACCOUNT_ID, {
      name: "Gym",
      address: "3 Lift Rd, Testing, CA",
      lat: null,
      lng: null,
    });
    const id = added.ok ? added.location.id : "";

    expect(
      await updateLocation(TEST_ACCOUNT_ID, id, {
        name: "Studio",
        address: "4 Lift Rd, Testing, CA",
        lat: 34.06,
        lng: -118.26,
      }),
    ).toMatchObject({
      ok: true,
      location: {
        id,
        name: "Studio",
        address: "4 Lift Rd, Testing, CA",
        lat: 34.06,
      },
    });
    expect(
      (await readLocations(TEST_ACCOUNT_ID)).find((l) => l.id === id),
    ).toMatchObject({ name: "Studio", address: "4 Lift Rd, Testing, CA" });

    // A name another place uses is refused...
    expect(
      await updateLocation(TEST_ACCOUNT_ID, id, {
        name: "Work",
        address: "4 Lift Rd, Testing, CA",
        lat: null,
        lng: null,
      }),
    ).toMatchObject({ ok: false });
    // ...but the row's own name in another case is not a clash with itself.
    expect(
      await updateLocation(TEST_ACCOUNT_ID, id, {
        name: "STUDIO",
        address: "4 Lift Rd, Testing, CA",
        lat: null,
        lng: null,
      }),
    ).toMatchObject({ ok: true, location: { name: "STUDIO" } });
    // An id from another account (or a stale one) touches nothing.
    expect(
      await updateLocation(TEST_ACCOUNT_ID, "loc_other_office", {
        name: "Mine",
        address: "5 Lift Rd, Testing, CA",
        lat: null,
        lng: null,
      }),
    ).toMatchObject({ ok: false, error: "That location no longer exists." });

    await removeLocation(TEST_ACCOUNT_ID, id);
  });

  it("drops a lone or out-of-range coordinate pair", async () => {
    const added = await addLocation(TEST_ACCOUNT_ID, {
      name: "Airport",
      address: "6 Jet Way, Testing, CA",
      lat: 34.05,
      lng: null,
    });
    const id = added.ok ? added.location.id : "";
    expect(added).toMatchObject({
      ok: true,
      location: { lat: null, lng: null },
    });

    expect(
      await updateLocation(TEST_ACCOUNT_ID, id, {
        name: "Airport",
        address: "6 Jet Way, Testing, CA",
        lat: 999,
        lng: -118.24,
      }),
    ).toMatchObject({ ok: true, location: { lat: null, lng: null } });

    await removeLocation(TEST_ACCOUNT_ID, id);
  });

  it("removes nothing but the account's own row", async () => {
    await removeLocation(OTHER_ACCOUNT_ID, "loc_test_work");
    await removeLocation(TEST_ACCOUNT_ID, "no-such-id");

    expect((await readLocations(TEST_ACCOUNT_ID)).map((l) => l.name)).toEqual([
      "Hospital",
      "Work",
    ]);
    expect((await readLocations(OTHER_ACCOUNT_ID)).map((l) => l.name)).toEqual([
      "Work",
    ]);
  });
});
