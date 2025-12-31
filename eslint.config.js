import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import globals from "globals";
import nodePlugin from "eslint-plugin-n";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

const baseExtends = [js.configs.recommended, ...tseslint.configs.recommended];
const baseRules = {
  semi: ["error", "always"],
  "@typescript-eslint/no-unused-expressions": "off",
  "no-unused-expressions": "off",
};
const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    ignores: ["frontend/dist", "backend/dist"],
  },
  {
    name: "frontend-react",
    files: ["frontend/**/*.{ts,tsx}"],
    extends: baseExtends,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        tsconfigRootDir,
      },
      ecmaVersion: 2020,
      sourceType: "module",
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      ...baseRules,
    },
  },
  {
    name: "backend-node",
    files: ["backend/**/*.ts"],
    extends: baseExtends,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        tsconfigRootDir,
      },
      ecmaVersion: 2020,
      sourceType: "module",
      globals: globals.node,
    },
    plugins: {
      n: nodePlugin,
    },
    rules: {
      ...baseRules,
      "n/no-missing-import": "off",
      "n/no-unsupported-features/es-syntax": "off",
    },
  },
  {
    name: "shared",
    files: ["shared/**/*.ts"],
    extends: baseExtends,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        tsconfigRootDir,
      },
      ecmaVersion: 2020,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: baseRules,
  },
  prettierConfig
);
