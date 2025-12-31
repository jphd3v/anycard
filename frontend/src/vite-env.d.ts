/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SERVER_URL: string;
  readonly VITE_BROWSER_LLM_ENABLED: string;
  readonly VITE_LLM_BASE_URL: string;
  readonly VITE_LLM_API_KEY: string;
  readonly VITE_LLM_MODEL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __COMMIT_HASH__: string;
declare const __COMMIT_DATE__: string;
