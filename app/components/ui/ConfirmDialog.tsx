import { Button } from "~/components/ui/Button";

/** Confirmation overlay for actions with real consequences. Deletion has no
 * undo, so every delete path (editor and list) confirms here; the reconcile
 * flow uses it for completing / discarding a statement too, with a custom
 * label and tone. */
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
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-4 text-center text-gray-700">{message}</p>
        <div className="flex justify-center gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          <Button
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
