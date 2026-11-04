import globals from "globals";

export default [
  { ignores: ["web/pkg/**", "node_modules/**", "dist/**"] },
  {
    files: ["web/*.js"],
    languageOptions: { globals: { ...globals.browser, ...globals.worker } },
    rules: { "no-undef": "error" },
  },
];
