import { useEffect, useRef, useState } from "react";

import { Markdown } from "~/components/Markdown";
import { revealTo } from "~/lib/insights";

const REVEAL_TICK_MS = 33;

/** Renders markdown with a ChatGPT-style reveal for a freshly arrived
 * answer; restored conversation history renders instantly (`reveal`
 * false). The text is re-parsed per tick, so the reveal stays
 * markdown-safe by construction (the custom parser degrades gracefully
 * on partial input). */
export function RevealText({
  text,
  reveal,
  onDone,
}: {
  text: string;
  reveal: boolean;
  onDone: () => void;
}) {
  const [pos, setPos] = useState(() =>
    reveal && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 0
      : text.length,
  );
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (!reveal) return;
    let pos = 0;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      pos = revealTo(text, pos, now - last);
      last = now;
      setPos(pos);
      if (pos >= text.length) {
        window.clearInterval(timer);
        onDoneRef.current();
      }
    };
    const timer = window.setInterval(tick, REVEAL_TICK_MS);
    return () => window.clearInterval(timer);
  }, [text, reveal]);
  return <Markdown text={text.slice(0, pos)} />;
}
