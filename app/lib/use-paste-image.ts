import { useEffect, useRef } from "react";

/**
 * Listen for paste events containing an image and forward the file to the
 * callback. Used on the home page (create a receipt from a pasted image)
 * and in the receipt editor (replace the receipt image).
 *
 * The handler subscribes once and always calls the latest callback via a
 * ref, so re-renders never churn the DOM listener.
 */
export function usePasteImage(onPaste: (file: File) => void): void {
  const onPasteRef = useRef(onPaste);
  useEffect(() => {
    onPasteRef.current = onPaste;
  }, [onPaste]);
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            onPasteRef.current(file);
            return;
          }
        }
      }
    };
    document.addEventListener("paste", handler);
    return () => document.removeEventListener("paste", handler);
  }, []);
}
