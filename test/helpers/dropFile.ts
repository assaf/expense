import type { JSHandle, Page } from "playwright";

/** A file to place on a drop's DataTransfer: `body` is the file's text, or
 * its bytes for a binary fixture. */
export interface DroppedFile {
  name: string;
  type: string;
  body: string | number[];
}

/**
 * A DataTransfer holding one file, for the drag-and-drop tests:
 *
 *   const transfer = await fileTransfer(page, {
 *     name: "drop.png",
 *     type: "image/png",
 *     body: [...png],
 *   });
 *   await page.locator("main").dispatchEvent("drop", { dataTransfer: transfer });
 *
 * Only the page can build one, and a DataTransfer is spent by the drop it
 * carries, so build a fresh one per event.
 */
export function fileTransfer(
  page: Page,
  file: DroppedFile,
): Promise<JSHandle<DataTransfer>> {
  return page.evaluateHandle(
    ([name, type, body]) => {
      const transfer = new DataTransfer();
      const part = Array.isArray(body) ? new Uint8Array(body) : body;
      transfer.items.add(new File([part], name, { type }));
      return transfer;
    },
    [file.name, file.type, file.body] as [string, string, string | number[]],
  );
}
