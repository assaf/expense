import { Button } from "~/components/ui/Button";

/** Destructive-action confirmation overlay. Deletion has no undo, so every
 * delete path (editor and list) confirms here before proceeding. */
export function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
  deleting,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  deleting: boolean;
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
          <Button variant="danger" onClick={onConfirm} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </div>
    </div>
  );
}
