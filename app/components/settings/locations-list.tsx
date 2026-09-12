import { useEffect, useRef, useState } from "react";
import { MapPin, Pencil, Plus } from "lucide-react";
import { Form, useFetcher } from "react-router";
import { cn } from "cn";
import { Button } from "~/components/ui/Button";
import { Field } from "~/components/ui/Field";
import { Input } from "~/components/ui/Input";
import { RemoveButton } from "~/components/settings/name-list";
import type { NamedLocation } from "~/lib/types";
import { MAX_ADDRESS_LENGTH } from "~/lib/types";

/** Server reply for an add or edit: success echoes the row, rejection
 * explains why. */
interface LocationSaveResult {
  ok: boolean;
  id?: string;
  name?: string;
  /** False when the map service did not recognize the address. */
  geocoded?: boolean;
  error?: string;
}

/** Shown when an address saved but the map service did not resolve it. */
const GEOCODE_NOTE =
  "Address saved, but the map service didn't recognize it. The trip editor will look it up again.";

/** The account's places: home first (fixed, since every trip starts and
 * ends there), then the named locations, then an add form. New rows come
 * from the loader revalidation, so the list updates without a page load. */
export function LocationsList({
  homeAddress,
  locations,
}: {
  homeAddress: string;
  locations: readonly NamedLocation[];
}) {
  const addFetcher = useFetcher<LocationSaveResult>();
  const [draftName, setDraftName] = useState("");
  const [draftAddress, setDraftAddress] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [noteId, setNoteId] = useState<string | null>(null);
  const flashRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    const { data } = addFetcher;
    if (!data) return;
    if (data.ok) {
      setDraftName("");
      setDraftAddress("");
      setAddError(null);
      if (data.id) {
        setFlashId(data.id);
        if (data.geocoded === false) setNoteId(data.id);
      }
    } else if (data.error) {
      setAddError(data.error);
    }
  }, [addFetcher.data]);

  // A new row landed: flash it. The loader revalidation has already added
  // it by the time this runs, so the flash ref is available.
  useEffect(() => {
    if (!flashId) return;
    flashRef.current?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
    const timer = setTimeout(() => setFlashId(null), 3000);
    return () => clearTimeout(timer);
  }, [flashId]);

  const [announcement, setAnnouncement] = useState<string | null>(null);
  useEffect(() => {
    if (!flashId) {
      setAnnouncement(null);
      return;
    }
    const name = locations.find((l) => l.id === flashId)?.name;
    setAnnouncement(name ? `Added ${name}` : null);
  }, [flashId, locations]);

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      <ul className="mb-3 flex flex-col gap-1">
        <li className="rounded-lg bg-gray-50 px-3 py-1.5 dark:bg-gray-900">
          <Form method="post" className="flex items-end gap-2">
            <input type="hidden" name="intent" value="saveHome" />
            <Field label="Home" className="min-w-0 flex-1">
              <Input
                type="text"
                name="homeAddress"
                maxLength={MAX_ADDRESS_LENGTH}
                defaultValue={homeAddress}
              />
            </Field>
            <Button type="submit" size="md">
              <MapPin aria-hidden="true" className="h-4 w-4" /> Save
            </Button>
          </Form>
        </li>
        {locations.map((location) => (
          <li
            key={location.id}
            ref={location.id === flashId ? flashRef : undefined}
            className={cn(
              "flex items-center justify-between gap-2 rounded-lg px-3 py-1.5 transition-colors duration-500",
              location.id === flashId
                ? "bg-amber-200 dark:bg-amber-800"
                : "bg-gray-50 dark:bg-gray-900",
            )}
          >
            <LocationRow
              location={location}
              addedNote={location.id === noteId ? GEOCODE_NOTE : undefined}
            />
          </li>
        ))}
      </ul>
      <addFetcher.Form method="post" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="intent" value="addLocation" />
        <Field label="Name" className="min-w-0 flex-1">
          <Input
            type="text"
            name="name"
            value={draftName}
            onChange={(e) => {
              setDraftName(e.target.value);
              setAddError(null);
            }}
            placeholder="Restaurant"
            aria-invalid={addError ? true : undefined}
            invalid={!!addError}
          />
        </Field>
        <Field label="Address" className="min-w-0 flex-1">
          <Input
            type="text"
            name="address"
            value={draftAddress}
            maxLength={MAX_ADDRESS_LENGTH}
            onChange={(e) => {
              setDraftAddress(e.target.value);
              setAddError(null);
            }}
            placeholder="123 Main St, Springfield"
          />
        </Field>
        <Button
          type="submit"
          size="md"
          variant="secondary"
          disabled={!draftName.trim() || !draftAddress.trim()}
        >
          <Plus aria-hidden="true" className="h-4 w-4" /> Add
        </Button>
      </addFetcher.Form>
      {addError ? (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">
          {addError}
        </p>
      ) : null}
    </>
  );
}

/** One named location: name + address, with an inline editor and a delete
 * button, both driven by fetchers so nothing navigates away. */
function LocationRow({
  location,
  addedNote,
}: {
  location: NamedLocation;
  /** Note from the add that created this row, when its address did not resolve. */
  addedNote?: string;
}) {
  const [editing, setEditing] = useState(false);
  const removeFetcher = useFetcher();
  const editFetcher = useFetcher<LocationSaveResult>();
  const [draftName, setDraftName] = useState(location.name);
  const [draftAddress, setDraftAddress] = useState(location.address);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const { data } = editFetcher;
    if (!data) return;
    if (data.ok) {
      setError(null);
      setEditing(false);
    } else if (data.error) {
      setError(data.error);
    }
  }, [editFetcher.data]);

  const editData = editFetcher.data;
  // A later successful edit decides the note: it either resolves (no note)
  // or reports its own failure to geocode.
  const note = editData?.ok
    ? editData.geocoded === false
      ? GEOCODE_NOTE
      : undefined
    : addedNote;

  if (editing) {
    return (
      <div className="flex w-full flex-col gap-1">
        <editFetcher.Form
          method="post"
          className="flex w-full flex-wrap items-end gap-2"
        >
          <input type="hidden" name="intent" value="updateLocation" />
          <input type="hidden" name="id" value={location.id} />
          <Field label="Name" className="min-w-0 flex-1">
            <Input
              type="text"
              name="name"
              value={draftName}
              onChange={(e) => {
                setDraftName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(false);
              }}
              autoFocus
              aria-invalid={error ? true : undefined}
              invalid={!!error}
              className="px-2 py-1"
            />
          </Field>
          <Field label="Address" className="min-w-0 flex-1">
            <Input
              type="text"
              name="address"
              value={draftAddress}
              maxLength={MAX_ADDRESS_LENGTH}
              onChange={(e) => {
                setDraftAddress(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(false);
              }}
              aria-invalid={error ? true : undefined}
              invalid={!!error}
              className="px-2 py-1"
            />
          </Field>
          <Button
            type="submit"
            size="sm"
            disabled={!draftName.trim() || !draftAddress.trim()}
          >
            Save
          </Button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="shrink-0 pb-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-ink"
          >
            Cancel
          </button>
        </editFetcher.Form>
        {error ? (
          <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{location.name}</span>
        <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
          {location.address}
        </span>
        {note ? (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            {note}
          </p>
        ) : null}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setDraftName(location.name);
            setDraftAddress(location.address);
            setError(null);
            setEditing(true);
          }}
          className="text-gray-500 dark:text-gray-400 hover:text-ink"
          aria-label={`Edit ${location.name}`}
        >
          <Pencil aria-hidden="true" className="h-4 w-4" />
        </button>
        <RemoveButton
          fetcher={removeFetcher}
          intent="removeLocation"
          fields={{ id: location.id }}
          label={`Delete ${location.name}`}
          confirm={`Delete the location "${location.name}"? Trips already saved keep its address.`}
        />
      </div>
    </>
  );
}
