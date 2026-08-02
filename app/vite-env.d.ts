// CSS side-effect imports (non-module)
declare module "*.css" {}

// Bundled font asset (base64 string) for server-side receipt rendering.
declare module "*.woff2?inline" {
  const src: string;
  export default src;
}

interface ImportMetaEnv {
  BASE_URL: string;
  MODE: string;
  DEV: boolean;
  PROD: boolean;
  SSR: boolean;
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
