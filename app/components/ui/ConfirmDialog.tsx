import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "~/components/ui/Button";

/** Confirmation overlay for actions with real consequences. Deletion has no
 * undo, so every delete path (editor and list) confirms here; the reconcile
 * flow uses it for completing / discarding a statement too, with a custom
 * label and tone.
 *
 * Traps focus inside the dialog while open and restores it on close. Escape
 * cancels; Tab cycles through the dialog's controls (the buttons, plus any
 * focusable `children`). */
export function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
  deleting,
  confirmLabel = "Delete",
  tone = "danger",
  children,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  deleting: boolean;
  /** Override the confirm button label (default: Delete). */
  confirmLabel?: string;
  /** "danger" (red, the delete default) or "primary" (ink). */
  tone?: "danger" | "primary";
  /** Extra content between the message and the buttons (e.g. an opt-in
   * checkbox). Rendered as a labeled region of the dialog. */
  children?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  // Capture the previously focused element and move focus into the dialog.
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    // Focus the least destructive action first (Cancel).
    cancelRef.current?.focus();
    return () => {
      previousFocus.current?.focus();
    };
  }, []);

  // Trap focus: Tab / Shift+Tab cycle through every control in the dialog.
  // The children may hold a field (the close-account password), so the cycle
  // is read from the DOM rather than assumed to be the two buttons: a
  // hardcoded Cancel/confirm pair would leave that field unreachable by Tab.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ].filter((el) => el.offsetParent !== null);
      if (focusable.length < 2) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const headingId = "confirm-dialog-heading";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        <p
          id={headingId}
          className="mb-4 text-center text-gray-700 dark:text-gray-200"
        >
          {message}
        </p>
        {children ? (
          <div className="mb-4 text-sm text-gray-600 dark:text-gray-300">
            {children}
          </div>
        ) : null}
        <div className="flex justify-center gap-2">
          <Button
            ref={cancelRef}
            variant="ghost"
            onClick={onCancel}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            variant={tone === "primary" ? "primary" : "danger"}
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
