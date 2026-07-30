import type { Config } from "@react-router/dev/config";

export default {
  // File-based routing is enabled; pages are SSR'd for fast first paint.
  ssr: true,
  prerender: async () => [],
} satisfies Config;
