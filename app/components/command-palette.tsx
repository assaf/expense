import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  CreditCard,
  Download,
  FileDown,
  FolderPlus,
  Home,
  ListChecks,
  Loader2,
  Mail,
  MapPinned,
  ReceiptText,
  Search,
  Settings,
  Upload,
} from "lucide-react";
import {
  KBarAnimator,
  KBarPortal,
  KBarPositioner,
  KBarProvider,
  KBarResults,
  KBarSearch,
  useKBar,
  useMatches,
  useRegisterActions,
  type Action,
  type ActionImpl,
} from "kbar";
import {
  useFetcher,
  useNavigate,
  type FetcherWithComponents,
} from "react-router";
import { Input } from "~/components/ui/Input";
import { requestCommand } from "~/lib/command-requests";

/** The Settings route action response for `intent=addCategory`. */
type AddCategoryResult =
  | { ok: true; name: string }
  | { ok: false; error: string };

/**
 * Cmd/Ctrl+K command palette (kbar), mounted once in the root layout for
 * signed-in users. Commands navigate, create (receipt/mileage/category),
 * trigger page-local file pickers and the expense search via the command
 * request bus, and export reports.
 *
 * The "Add category" prompt replaces the palette: kbar always closes the
 * palette after a performed action, so the prompt renders outside the
 * portal (which unmounts per close) as its own overlay while the palette
 * hides. kbar's search input is unmounted during the prompt, which keeps
 * kbar's window key handlers (Enter-to-select, refocus) out of the way.
 */
export function CommandMenu({ reportNames }: { reportNames: string[] }) {
  return (
    <KBarProvider options={{ disableScrollbarManagement: true }}>
      <Palette reportNames={reportNames} />
    </KBarProvider>
  );
}

function Palette({ reportNames }: { reportNames: string[] }) {
  const navigate = useNavigate();
  const fetcher = useFetcher<AddCategoryResult>();
  const { visualState, searchQuery, query } = useKBar((state) => ({
    visualState: state.visualState,
    searchQuery: state.searchQuery,
  }));
  // `prompting` lives above the portal (which unmounts per close), so it
  // must be reset explicitly whenever the palette reopens, including a
  // Cmd+K pressed while the prompt is showing.
  const [prompting, setPrompting] = useState<null | "category">(null);
  useEffect(() => {
    if (visualState === "showing") setPrompting(null);
  }, [visualState]);

  // A search request is held until the palette is fully hidden: kbar
  // restores focus to the pre-palette element while the palette closes,
  // which would blur the search box the home page focuses in response.
  // Gating on `hidden` means the request can never race that blur.
  const [pendingSearch, setPendingSearch] = useState<string | null>(null);
  useEffect(() => {
    if (visualState === "hidden" && pendingSearch !== null) {
      requestCommand({ kind: "search-expenses", query: pendingSearch });
      setPendingSearch(null);
    }
  }, [visualState, pendingSearch]);

  // Category created → leave for Settings and drop the prompt. `navigate`
  // is stable, so this fires exactly once when the fetcher resolves.
  useEffect(() => {
    if (fetcher.data?.ok) {
      void navigate("/settings");
      setPrompting(null);
    }
  }, [fetcher.data, navigate]);

  const actions = useMemo<Action[]>(
    () => [
      {
        id: "nav-expenses",
        shortcut: ["g", "e"],
        name: "Go to Expenses",
        section: "Navigate",
        keywords: "receipts list home",
        icon: <Home aria-hidden="true" className="h-4 w-4" />,
        perform: () => void navigate("/"),
      },
      {
        id: "nav-reports",
        shortcut: ["g", "r"],
        name: "Go to Reports",
        section: "Navigate",
        keywords: "export pdf download",
        icon: <Download aria-hidden="true" className="h-4 w-4" />,
        perform: () => void navigate("/export"),
      },
      {
        id: "nav-emails",
        shortcut: ["g", "m"],
        name: "Go to Emails",
        section: "Navigate",
        keywords: "mail inbox fastmail",
        icon: <Mail aria-hidden="true" className="h-4 w-4" />,
        perform: () => void navigate("/emails"),
      },
      {
        id: "nav-reconcile",
        shortcut: ["g", "f"],
        name: "Go to Reconcile",
        section: "Navigate",
        keywords: "statement credit card match",
        icon: <ListChecks aria-hidden="true" className="h-4 w-4" />,
        perform: () => void navigate("/reconcile"),
      },
      {
        id: "nav-settings",
        shortcut: ["g", "s"],
        name: "Go to Settings",
        section: "Navigate",
        keywords: "preferences account",
        icon: <Settings aria-hidden="true" className="h-4 w-4" />,
        perform: () => void navigate("/settings"),
      },
      {
        id: "new-receipt",
        shortcut: ["a"],
        name: "Add receipt",
        section: "Create",
        keywords: "expense new",
        icon: <ReceiptText aria-hidden="true" className="h-4 w-4" />,
        perform: () => void navigate("/expense/new"),
      },
      {
        id: "new-mileage",
        shortcut: ["m"],
        name: "Add mileage expense",
        section: "Create",
        keywords: "drive miles trip",
        icon: <MapPinned aria-hidden="true" className="h-4 w-4" />,
        perform: () => void navigate("/expense/new?type=mileage"),
      },
      {
        id: "upload-expense",
        shortcut: ["f"],
        name: "Upload expense file",
        section: "Create",
        keywords: "receipt image pdf photo",
        icon: <Upload aria-hidden="true" className="h-4 w-4" />,
        perform: () => {
          requestCommand({ kind: "upload-expense" });
          void navigate("/");
        },
      },
      {
        id: "add-category",
        name: "Add category",
        section: "Create",
        keywords: "new category schedule c",
        icon: <FolderPlus aria-hidden="true" className="h-4 w-4" />,
        // kbar closes the palette after this perform; the prompt overlay
        // renders in its place (see Palette's render).
        perform: () => {
          fetcher.reset();
          setPrompting("category");
        },
      },
      {
        id: "upload-reconcile",
        name: "Upload reconcile statement",
        section: "Create",
        keywords: "statement csv credit card",
        icon: <CreditCard aria-hidden="true" className="h-4 w-4" />,
        perform: () => {
          requestCommand({ kind: "upload-reconcile" });
          void navigate("/reconcile");
        },
      },
      // Typing a real query swaps the bare "Search expenses" command for a
      // query-carrying one; kbar's `tokenMatch: "all"` would otherwise
      // hide the command the moment extra words are typed. The action name
      // embeds the query, so Fuse keeps matching it as the user types.
      ...(searchQuery.trim().length >= 2
        ? [
            {
              id: "search-expenses-query",
              name: `Search expenses for "${searchQuery.trim()}"`,
              section: "Search",
              keywords: "find filter query amount merchant",
              icon: <Search aria-hidden="true" className="h-4 w-4" />,
              // The request is deferred until the palette is hidden (see
              // the pendingSearch effect) so its focus can't be stolen by
              // kbar's close-time focus restore.
              perform: () => {
                setPendingSearch(searchQuery.trim());
                void navigate("/");
              },
            },
          ]
        : [
            {
              id: "search-expenses",
              name: "Search expenses",
              shortcut: ["?"],
              section: "Search",
              keywords: "find filter query amount merchant",
              icon: <Search aria-hidden="true" className="h-4 w-4" />,
              perform: () => {
                setPendingSearch(searchQuery.trim());
                void navigate("/");
              },
            },
          ]),
      // Parent first so its children attach to an existing action; the
      // parent keeps a perform fallback (never an empty submenu).
      {
        id: "export-report",
        name: "Export report",
        shortcut: ["e"],
        section: "Export",
        keywords: "download pdf tax",
        icon: <FileDown aria-hidden="true" className="h-4 w-4" />,
        ...(reportNames.length === 0
          ? { perform: () => void navigate("/export") }
          : {}),
      },
      ...reportNames.map((name, i) => ({
        id: `export-${i}`,
        name,
        section: "Export",
        icon: <FileDown aria-hidden="true" className="h-4 w-4" />,
        parent: "export-report",
        perform: () => {
          window.location.href = `/export/report/${encodeURIComponent(name)}.pdf`;
        },
      })),
    ],
    [
      navigate,
      reportNames,
      setPrompting,
      fetcher,
      searchQuery,
      setPendingSearch,
    ],
  );

  useRegisterActions(actions, [actions]);

  const { results } = useMatches();

  return (
    <>
      <KBarPortal>
        <KBarPositioner className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 p-4 pt-[18vh]">
          <KBarAnimator className="w-full max-w-[600px] overflow-hidden rounded-lg bg-[rgb(252_252_252)] text-[rgb(28_28_29)] shadow-[0px_6px_20px_rgb(0_0_0/20%)] dark:bg-[rgb(28_28_29)] dark:text-[rgba(252_252_252/0.9)] dark:shadow-none">
            {prompting === "category" ? null : (
              <>
                <div className="flex items-center gap-3 py-1 pl-4 pr-3">
                  <Search
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 opacity-50"
                  />
                  <KBarSearch
                    defaultPlaceholder="Type a command or search…"
                    style={{
                      outline: "none",
                      border: "none",
                      boxShadow: "none",
                    }}
                    className="w-full box-border bg-transparent py-3 text-base placeholder:opacity-50 dark:text-gray-100"
                  />
                  <kbd className="shrink-0 text-[10px] uppercase opacity-50">
                    esc
                  </kbd>
                </div>
                {results.length === 0 ? (
                  <div className="px-4 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                    No matching commands
                  </div>
                ) : (
                  <KBarResults
                    items={results}
                    maxHeight={380}
                    onRender={({
                      item,
                      active,
                    }: {
                      item: string | ActionImpl;
                      active: boolean;
                    }) =>
                      typeof item === "string" ? (
                        <div className="px-4 py-2 text-[10px] uppercase opacity-50">
                          {item}
                        </div>
                      ) : (
                        <button
                          type="button"
                          aria-selected={active}
                          className={`flex w-full cursor-pointer items-center justify-between gap-3 border-l-2 px-4 py-3 text-left text-sm ${
                            active
                              ? "border-l-[rgb(28_28_29)] bg-black/5 dark:border-l-[rgba(252_252_252/0.9)] dark:bg-[rgb(53_53_54)]"
                              : "border-l-transparent"
                          }`}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="shrink-0 opacity-60">
                              {item.icon}
                            </span>
                            <span className="truncate">{item.name}</span>
                          </span>
                          {item.shortcut?.length ? (
                            <span className="ml-auto flex shrink-0 gap-1">
                              {item.shortcut.map((key) => (
                                <kbd
                                  key={key}
                                  className="rounded border border-gray-300 px-1.5 py-0.5 text-[10px] font-medium text-gray-400 dark:border-gray-600"
                                >
                                  {key}
                                </kbd>
                              ))}
                            </span>
                          ) : null}
                        </button>
                      )
                    }
                  />
                )}
              </>
            )}
          </KBarAnimator>
        </KBarPositioner>
      </KBarPortal>
      {prompting === "category" ? (
        <CategoryPrompt
          fetcher={fetcher}
          onCancel={() => {
            setPrompting(null);
            query.toggle();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * "Add category" overlay shown in place of the closed palette. Submits
 * through the Settings route action (intent=addCategory); the parent
 * navigates to Settings and clears the prompt on success.
 */
function CategoryPrompt({
  fetcher,
  onCancel,
}: {
  fetcher: FetcherWithComponents<AddCategoryResult>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = fetcher.state !== "idle";
  const data = fetcher.data;
  const error = data && !data.ok ? data.error : null;

  // kbar restores focus to the element focused before the palette opened
  // once the palette closes. That blur can hit this input mid-interaction.
  // Refocus once the palette is fully hidden (the blur is one-shot, so the
  // focus sticks).
  const { visualState } = useKBar((state) => ({
    visualState: state.visualState,
  }));
  useEffect(() => {
    if (visualState === "hidden") inputRef.current?.focus();
  }, [visualState]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    formData.set("intent", "addCategory");
    formData.set("name", name.trim());
    void fetcher.submit(formData, { method: "post", action: "/settings" });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 p-4 pt-[18vh]">
      <form
        onSubmit={submit}
        className="w-full max-w-[600px] rounded-lg bg-[rgb(252_252_252)] p-4 text-[rgb(28_28_29)] shadow-[0px_6px_20px_rgb(0_0_0/20%)] dark:bg-[rgb(28_28_29)] dark:text-[rgba(252_252_252/0.9)] dark:shadow-none"
      >
        <div className="flex items-center gap-2">
          <FolderPlus aria-hidden="true" className="h-4 w-4 text-gray-400" />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
            Add category
          </span>
          <kbd className="ml-auto rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-400 dark:border-gray-600">
            esc
          </kbd>
        </div>
        <div className="mt-4">
          <Input
            ref={inputRef}
            autoFocus
            aria-label="Category name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              // Escape cancels the prompt (and reopens the palette). No
              // kbar window handler is active while the palette is closed,
              // but stopPropagation keeps it that way regardless.
              if (e.key === "Escape") {
                e.stopPropagation();
                onCancel();
              }
            }}
            placeholder="e.g. Office supplies"
            className="w-full"
          />
        </div>
        <div className="mt-4 flex items-center justify-end gap-3">
          {error ? (
            <span
              role="alert"
              className="text-sm text-red-600 dark:text-red-400"
            >
              {error}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || name.trim().length === 0}
            className="flex items-center gap-2 rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
          >
            {busy ? (
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            ) : null}
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </form>
    </div>
  );
}
