import { useEffect, useRef, useState } from "react";

/**
 * The shared ok/error notice for the settings forms that submit via a
 * fetcher: on success (`ok` + `address`), reset the form and confirm;
 * otherwise surface the action's error text. The effect runs on `data`
 * changes only, like the inline effects this hook replaced; the callbacks
 * are read through refs so callers can pass fresh arrows.
 */
export function useFetcherNotice(
  data: { ok: boolean; error?: string; address?: string } | undefined,
  successText: (address: string) => string,
  reset: () => void,
): {
  notice: { ok: boolean; text: string } | null;
  setNotice: (notice: { ok: boolean; text: string } | null) => void;
} {
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const successRef = useRef(successText);
  const resetRef = useRef(reset);
  useEffect(() => {
    successRef.current = successText;
    resetRef.current = reset;
  });
  useEffect(() => {
    if (!data) return;
    if (data.ok && data.address) {
      resetRef.current();
      setNotice({ ok: true, text: successRef.current(data.address) });
    } else if (data.error) {
      setNotice({ ok: false, text: data.error });
    }
  }, [data]);
  return { notice, setNotice };
}
