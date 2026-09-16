/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  extends: ["@remix-run/eslint-config", "@remix-run/eslint-config/node"],
  globals: { shopify: "readonly" },
  ignorePatterns: ["build/**", "node_modules/**", "extensions/**", "coverage/**"],
  rules: {
    "no-console": ["warn", { allow: ["warn", "error", "info"] }],
  },
  overrides: [
    {
      // Command-line scripts: printing to the console is what they are for.
      files: ["scripts/**/*.ts", "prisma/seed.ts"],
      rules: { "no-console": "off" },
    },
  ],
};
