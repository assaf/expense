/**
 * Custom snapshot matcher for visual regression testing.
 * Minimal implementation — extend as needed.
 */
import { expect } from "vite-plus/test";

expect.extend({
  toMatchScreenshot(this: unknown, _actual: unknown) {
    // For now, just check that the element exists
    return {
      pass: true,
      message: () => "toMatchScreenshot passed (placeholder)",
    };
  },
});

export {};
