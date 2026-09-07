/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  extends: ["@remix-run/eslint-config", "@remix-run/eslint-config/node"],
  globals: { shopify: "readonly" },
  ignorePatterns: ["build/**", "node_modules/**", "extensions/**", "coverage/**"],
  rules: {
    "no-console": ["warn", { allow: ["warn", "error", "info"] }],
  },
};
