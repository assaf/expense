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
