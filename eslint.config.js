import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(
  { ignores: ["references/**", "dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["src/cli.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    files: ["tests/**/*.ts"],
    rules: { "@typescript-eslint/no-empty-function": "off" },
  },
);
