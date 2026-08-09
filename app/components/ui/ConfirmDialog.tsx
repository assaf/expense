import { useEffect, useRef } from "react";
import { Button } from "~/components/ui/Button";

/** Confirmation overlay for actions with real consequences. Deletion has no
 * undo, so every delete path (editor and list) confirms here; the reconcile
 * flow uses it for completing / discarding a statement too, with a custom
 * label and tone.
 *
 * Traps focus inside the dialog while open and restores it on close. Escape
 * cancels; Tab wraps between Cancel and the action button. */
export function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
  deleting,
  confirmLabel = "Delete",
  tone = "danger",
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  deleting: boolean;
  /** Override the confirm button label (default: Delete). */
  confirmLabel?: string;
  /** "danger" (red, the delete default) or "primary" (ink). */
  tone?: "danger" | "primary";
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

  // Trap focus: Tab / Shift+Tab cycle between Cancel and the action button.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = [cancelRef.current, confirmRef.current].filter(
        (el): el is HTMLButtonElement => el !== null,
      );
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
        className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p id={headingId} className="mb-4 text-center text-gray-700">
          {message}
        </p>
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
