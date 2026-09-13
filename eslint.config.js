// Flat ESLint config. Deliberately CONSERVATIVE: this repo has a mature, heavily-commented,
// intentional style, so eslint is here to catch BUGS (floating promises, unsafe patterns), not to
// relitigate formatting. Type-unaware recommended rules (fast) plus a small set of high-value ones.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "app/engine/**",
      "app/node_modules/**",
      "app/runtime/**",
      "app/renderer/**",
      "dist/**",
      "dist-app/**",    // electron-builder output (win-unpacked, bundled deps)
      "node_modules/**",
      "tools/**",       // Python
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // tsconfig's noUnusedLocals/noUnusedParameters already covers unused vars at build time;
      // let TS own it so eslint does not double-report with different semantics.
      "@typescript-eslint/no-unused-vars": "off",
      // The codebase uses `any` deliberately at a few JSON/ESPN-payload boundaries; flag as warn,
      // not error, so it does not block the lint gate over well-understood boundaries.
      "@typescript-eslint/no-explicit-any": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }], // empty catch is an intentional pattern here
    },
  },
  {
    // Plain-JS Electron main/preload + .mjs scripts: no TS project, browser+node globals.
    files: ["app/*.js", "scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { "@typescript-eslint/no-require-imports": "off" }, // main.js uses require() (Electron CJS)
  },
);
