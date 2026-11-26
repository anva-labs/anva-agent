import { defineConfig } from "vite-plus";

const ignored = ["**/node_modules/**", "**/dist/**", "**/.anva/**", "**/.env*", "pnpm-lock.yaml"];

export default defineConfig({
  fmt: {
    semi: true,
    singleQuote: false,
    tabWidth: 2,
    trailingComma: "all",
    printWidth: 100,
    ignorePatterns: ignored,
  },
  lint: {
    ignorePatterns: ignored,
    options: { typeAware: true, typeCheck: true },
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/cli/src/**/*.test.ts"],
  },
  run: {
    cache: { scripts: false, tasks: true },
  },
});
