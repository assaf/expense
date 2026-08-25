// CSS side-effect imports (non-module)
declare module "*.css" {}

// Bundled font asset (base64 string) for server-side receipt rendering.
declare module "*.woff2?inline" {
  const src: string;
  export default src;
}

// Bundled CSV data file (raw UTF-8 string), e.g. default categories.
declare module "*.csv?raw" {
  const src: string;
  export default src;
}

interface ImportMetaEnv {
  BASE_URL: string;
  MODE: string;
  DEV: boolean;
  PROD: boolean;
  SSR: boolean;
  /** Sentry client DSN (build-time; server uses process.env.SENTRY_DSN). */
  VITE_SENTRY_DSN?: string;
  /** Deploy commit SHA, injected by vite.config; tags client events with
   * the release the sourcemaps were uploaded to. */
  VITE_SENTRY_RELEASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Umami tracker global (script.js loads only in production).
interface Window {
  umami?: {
    identify: (data: Record<string, string>) => void;
    track: (event: string, data?: Record<string, unknown>) => void;
  };
}
